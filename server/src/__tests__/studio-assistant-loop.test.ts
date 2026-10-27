import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StudioAssistantTurn } from "@paperclipai/shared";

/**
 * A scripted OpenAI-compatible API: each model answers with the next reply in
 * its own script (a tool call, words, or a reply cut off by the length
 * limit), and "Done." once its script runs out.
 */
interface ScriptedReply {
  content?: string;
  call?: { name: string; args: Record<string, unknown> };
  finish?: string;
}
type ChatRequest = { model: string; messages: Array<{ role: string; content: unknown }> };

let server: http.Server;
let baseUrl = "";
let root = "";
const scripts = new Map<string, ScriptedReply[]>();
const requests: ChatRequest[] = [];
let callId = 0;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "studio-loop-"));
  process.env.PAPERCLIP_STUDIO_DIR = root;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as ChatRequest;
      requests.push(body);
      const reply = scripts.get(body.model)?.shift() ?? { content: "Done." };
      const message = reply.call
        ? { role: "assistant", content: null, tool_calls: [{ id: `call_${++callId}`, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }] }
        : { role: "assistant", content: reply.content ?? "" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message, finish_reason: reply.finish ?? (reply.call ? "tool_calls" : "stop") }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.close();
  delete process.env.PAPERCLIP_STUDIO_DIR;
  await rm(root, { recursive: true, force: true });
});

let workspace = 0;
async function turn(script: Record<string, ScriptedReply[]>, options: { team?: string[] } = {}) {
  const { runAssistantTurn, isAssistantRunning, readAssistantTranscript } = await import("../services/studio/assistant.js");
  const workspaceId = `loop-${++workspace}`;
  const files = path.join(root, "company-1", workspaceId, "files");
  await mkdir(files, { recursive: true });
  scripts.clear();
  for (const [model, replies] of Object.entries(script)) scripts.set(model, [...replies]);
  requests.length = 0;
  await runAssistantTurn({
    context: {
      workspaceId,
      companyId: "company-1",
      name: "Demo",
      language: "python",
      runCommand: "python main.py",
      startApp: async () => {},
      onFileChanged: async () => {},
    },
    message: "Build it",
    provider: "openai",
    model: "lead",
    credentials: { apiKey: "sk-test-key", baseUrl },
    ...(options.team ? { team: options.team.map((model) => ({ provider: "openai" as const, model, credentials: { apiKey: "sk-test-key", baseUrl } })) } : {}),
  });
  for (let waited = 0; isAssistantRunning(workspaceId) && waited < 10_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isAssistantRunning(workspaceId)).toBe(false);
  const transcript = await readAssistantTranscript("company-1", workspaceId);
  const reply = transcript.at(-1) as StudioAssistantTurn;
  expect(reply.role).toBe("assistant");
  return { reply, files, workspaceId };
}

const lastUserText = (request: ChatRequest) => {
  const last = [...request.messages].reverse().find((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
};

describe("Studio assistant loop", () => {
  it("asks a model that stops without a word to finish, instead of ending with no result", async () => {
    const { reply, files } = await turn({
      lead: [
        { call: { name: "write_file", args: { path: "main.py", content: "print('hi')\n" } } },
        { content: "" },
        { content: "Wrote main.py; run it with python main.py." },
      ],
    });
    expect(await readFile(path.join(files, "main.py"), "utf8")).toBe("print('hi')\n");
    expect(lastUserText(requests[2]!)).toContain("You stopped without saying anything");
    expect(reply.text).toBe("Wrote main.py; run it with python main.py.");
    expect(reply.error).toBeNull();
  });

  it("tells the person what was done when the model never says anything", async () => {
    const { reply } = await turn({
      lead: [
        { call: { name: "write_file", args: { path: "a.txt", content: "a" } } },
        { content: "" },
        { content: "" },
        { content: "" },
      ],
    });
    expect(reply.text).toContain("Here is what I did:");
    expect(reply.text).toContain("Created a.txt");
  });

  it("continues a reply the length limit cut off", async () => {
    const { reply } = await turn({
      lead: [
        { content: "Part one,", finish: "length" },
        { content: "part two." },
      ],
    });
    expect(lastUserText(requests[1]!)).toContain("cut off by the length limit");
    expect(reply.text).toBe("Part one,\n\npart two.");
  });

  it("refuses the same call repeated over and over", async () => {
    const read = { call: { name: "list_files", args: {} } };
    const { reply } = await turn({ lead: [read, read, read, read, { content: "Stopped looping." }] });
    const toolResults = requests.at(-1)!.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
    expect(toolResults).toHaveLength(4);
    expect(toolResults[3]).toContain("You already ran list_files with exactly this input 3 times");
    expect(reply.steps.filter((step) => step.tool === "list_files").at(-1)?.summary).toContain("skipped: same as before");
  });

  it("undoes its own edits, walking back through a file's history", async () => {
    const { reply, files } = await turn({
      lead: [
        { call: { name: "write_file", args: { path: "notes.md", content: "one" } } },
        { call: { name: "edit_file", args: { path: "notes.md", old_text: "one", new_text: "two" } } },
        { call: { name: "undo_edit", args: { path: "notes.md" } } },
        { call: { name: "undo_edit", args: { path: "notes.md" } } },
        { content: "Back to where we started." },
      ],
    });
    const changes = reply.steps.filter((step) => step.editId);
    expect(changes.map((step) => step.summary)).toEqual([
      "Created notes.md",
      "Edited notes.md",
      "Undid the change to notes.md",
      "Undid the change to notes.md",
    ]);
    // The first undo put back "one"; the second removed the file the first write created.
    await expect(stat(path.join(files, "notes.md"))).rejects.toThrow();
  });

  it("lets the person undo a step, and refuses once the file has moved on", async () => {
    const { undoEdit } = await import("../services/studio/edits.js");
    const { reply, files, workspaceId } = await turn({
      lead: [
        { call: { name: "write_file", args: { path: "app.py", content: "v1" } } },
        { call: { name: "write_file", args: { path: "app.py", content: "v2" } } },
        { call: { name: "write_file", args: { path: "app.py", content: "v3" } } },
        { content: "Done." },
      ],
    });
    const [first, second, third] = reply.steps.filter((step) => step.editId).map((step) => step.editId!);
    await expect(undoEdit("company-1", workspaceId, { id: second }, "you")).rejects.toThrow(/changed after that edit/);
    await undoEdit("company-1", workspaceId, { id: third }, "you");
    expect(await readFile(path.join(files, "app.py"), "utf8")).toBe("v2");
    await undoEdit("company-1", workspaceId, { id: second }, "you");
    expect(await readFile(path.join(files, "app.py"), "utf8")).toBe("v1");
    await expect(undoEdit("company-1", workspaceId, { id: second }, "you")).rejects.toThrow(/already undone/);
    expect(first).toBeTruthy();
  });

  it("runs teammates in parallel with roles, waits for all of them, then carries on", async () => {
    const { reply, files } = await turn({
      lead: [
        {
          call: {
            name: "run_team",
            args: {
              assignments: [
                { teammate: "mate-api", role: "backend: the API in api.py", task: "Write api.py" },
                { teammate: "mate-ui", role: "frontend: the page in index.html", task: "Write index.html" },
              ],
            },
          },
        },
        { content: "The team built the API and the page; both are in place." },
      ],
      "mate-api": [
        { call: { name: "write_file", args: { path: "api.py", content: "API = True\n" } } },
        { content: "api.py is written." },
      ],
      "mate-ui": [
        { call: { name: "write_file", args: { path: "index.html", content: "<h1>Hi</h1>\n" } } },
        { content: "index.html is written." },
      ],
    }, { team: ["mate-api", "mate-ui"] });

    expect(await readFile(path.join(files, "api.py"), "utf8")).toBe("API = True\n");
    expect(await readFile(path.join(files, "index.html"), "utf8")).toBe("<h1>Hi</h1>\n");
    expect(reply.agents?.map((agent) => [agent.model, agent.role, agent.status, agent.steps])).toEqual([
      ["mate-api", "backend: the API in api.py", "done", 1],
      ["mate-ui", "frontend: the page in index.html", "done", 1],
    ]);
    expect(reply.agents?.map((agent) => agent.report)).toEqual(["api.py is written.", "index.html is written."]);
    // Each teammate's steps are kept, tagged with the teammate that took them.
    const byAgent = new Map(reply.agents!.map((agent) => [agent.id, agent.model]));
    expect(reply.steps.filter((step) => step.agent && step.tool === "write_file").map((step) => byAgent.get(step.agent!))).toEqual(
      expect.arrayContaining(["mate-api", "mate-ui"]),
    );
    // The lead waited for both reports before it went on.
    const team = reply.steps.find((step) => step.tool === "run_team");
    expect(team?.summary).toBe("Team of 2 finished: 2 done");
    const leadFollowUp = requests.filter((request) => request.model === "lead").at(-1)!;
    const teamResult = String(leadFollowUp.messages.find((message) => message.role === "tool")?.content);
    expect(teamResult).toContain("api.py is written.");
    expect(teamResult).toContain("index.html is written.");
    expect(reply.text).toBe("The team built the API and the page; both are in place.");
  });
});

describe("Studio assistant on the free models", () => {
  it("rides out a busy provider on every step and keeps the tool history native", async () => {
    const { resetFreeModelHealth } = await import("@paperclipai/shared/puter-ai");
    const { runAssistantTurn, isAssistantRunning, readAssistantTranscript } = await import("../services/studio/assistant.js");
    resetFreeModelHealth();
    const busy = () => new Response(JSON.stringify({ error: "AI provider rate limit exceeded", code: "upstream_rate_limited" }), { status: 429, headers: { "content-type": "application/json" } });
    const ndjson = (events: unknown[]) => new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    const replies = [
      busy, busy, busy,
      () => ndjson([{ type: "tool_use", id: "t1", name: "write_file", input: { path: "hi.txt", content: "hi" } }, { type: "usage", usageDetails: { inputTokens: 3, outputTokens: 1 }, stopReason: "tool_use" }]),
      busy, busy, busy,
      () => ndjson([{ type: "text", text: "Wrote hi.txt." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 3 } }]),
    ];
    const sent: Array<{ messages: Array<{ role: string }> }> = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith("https://api.puter.com/")) return realFetch(url, init);
      sent.push((JSON.parse(String(init?.body)) as { args: { messages: Array<{ role: string }> } }).args);
      return replies.shift()!();
    });
    try {
      const workspaceId = `loop-free-${++workspace}`;
      await mkdir(path.join(root, "company-1", workspaceId, "files"), { recursive: true });
      await runAssistantTurn({
        context: { workspaceId, companyId: "company-1", name: "Demo", language: "python", runCommand: "python main.py", startApp: async () => {}, onFileChanged: async () => {} },
        message: "Write hi.txt",
        provider: "free",
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        credentials: { apiKey: "free", baseUrl: null },
      });
      for (let waited = 0; isAssistantRunning(workspaceId) && waited < 10_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
      const reply = (await readAssistantTranscript("company-1", workspaceId)).at(-1)!;
      expect(reply.error).toBeNull();
      expect(reply.text).toBe("Wrote hi.txt.");
      expect(sent.at(-1)!.messages.some((message) => message.role === "tool")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
