import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StudioAssistantTurn } from "@paperclipai/shared";
import type { StudioAiUsage } from "../services/studio/assistant.js";

/**
 * A scripted OpenAI-compatible API: each model answers with the next reply in
 * its own script (a tool call, words, or a reply cut off by the length
 * limit), and "Done." once its script runs out.
 */
interface ScriptedReply {
  content?: string;
  call?: { name: string; args: Record<string, unknown> };
  /** Several tool calls in one reply. */
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
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
      const calls = reply.calls ?? (reply.call ? [reply.call] : []);
      const message = calls.length
        ? { role: "assistant", content: null, tool_calls: calls.map((call) => ({ id: `call_${++callId}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
        : { role: "assistant", content: reply.content ?? "" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message, finish_reason: reply.finish ?? (calls.length ? "tool_calls" : "stop") }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  // Loaded here so the first test does not spend its time limit on the import
  // (on a busy machine it ran out, and its turn then took the next test's replies).
  await import("../services/studio/assistant.js");
});

afterAll(async () => {
  server.close();
  delete process.env.PAPERCLIP_STUDIO_DIR;
  await rm(root, { recursive: true, force: true });
});

let workspace = 0;
async function turn(
  script: Record<string, ScriptedReply[]>,
  options: {
    team?: string[];
    /** The teammates' provider (the lead's is openai unless `provider` says otherwise). */
    teamProvider?: "openai" | "custom";
    /** Records what each provider and model used, as Costs does. */
    onUsage?: (usage: StudioAiUsage) => void;
    /** Carries on in this project instead of a new one. */
    workspaceId?: string;
    provider?: "openai" | "custom";
    model?: string;
    message?: string;
    /** Runs before the turn, with the project's id and files folder. */
    setup?: (workspaceId: string, files: string) => Promise<void>;
    /** Taps Stop once the assistant is doing this (its activity line). */
    stopWhen?: string;
  } = {},
) {
  const { runAssistantTurn, isAssistantRunning, readAssistantTranscript, currentAssistantTurn, stopAssistant } = await import("../services/studio/assistant.js");
  const workspaceId = options.workspaceId ?? `loop-${++workspace}`;
  const files = path.join(root, "company-1", workspaceId, "files");
  await mkdir(files, { recursive: true });
  await options.setup?.(workspaceId, files);
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
      ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    },
    message: options.message ?? "Build it",
    provider: options.provider ?? "openai",
    model: options.model ?? "lead",
    credentials: { apiKey: "sk-test-key", baseUrl },
    ...(options.team ? { team: options.team.map((model) => ({ provider: options.teamProvider ?? "openai", model, credentials: { apiKey: "sk-test-key", baseUrl } })) } : {}),
  });
  if (options.stopWhen) {
    for (let waited = 0; !currentAssistantTurn(workspaceId)?.activity?.startsWith(options.stopWhen) && waited < 10_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stopAssistant(workspaceId);
  }
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

  it("reads or runs the same thing again once the project changed, but still stops a repeated change", async () => {
    const read = { call: { name: "read_file", args: { path: "notes.txt" } } };
    await turn({
      lead: [
        { call: { name: "write_file", args: { path: "notes.txt", content: "one" } } },
        read, read, read,
        { call: { name: "write_file", args: { path: "notes.txt", content: "two" } } },
        read,
        { content: "Checked." },
      ],
    });
    const toolResults = () => requests.at(-1)!.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
    expect(toolResults().at(-1)).toBe("two");

    const write = { call: { name: "write_file", args: { path: "same.txt", content: "x" } } };
    await turn({ lead: [write, write, write, write, { content: "Stopped rewriting." }] });
    expect(toolResults()[3]).toContain("You already ran write_file with exactly this input 3 times");
  });

  it("stops between tool calls when the person taps Stop", async () => {
    const { reply, files } = await turn({
      lead: [{ calls: [{ name: "run_command", args: { command: "sleep 5" } }, { name: "write_file", args: { path: "late.txt", content: "after Stop" } }] }],
    }, { stopWhen: "Running sleep" });
    expect(reply.error).toBe("Stopped.");
    await expect(stat(path.join(files, "late.txt"))).rejects.toThrow();
  });

  it("keeps a long console inside the tool output limit, newest lines included", async () => {
    await turn({ lead: [{ call: { name: "read_console", args: { lines: 1000 } } }, { content: "Read it." }] }, {
      setup: async (workspaceId) => {
        const { studioRuntime } = await import("../services/studio/runner.js");
        for (let line = 0; line < 100; line += 1) studioRuntime(workspaceId).append("stdout", `${line} ${"x".repeat(3990)}`);
        studioRuntime(workspaceId).append("stdout", "the newest line");
      },
    });
    const result = String(requests.at(-1)!.messages.find((message) => message.role === "tool")?.content);
    expect(result.length).toBeLessThan(41_000);
    expect(result).toContain("the newest line");
  });

  it("stops a search pattern that would never finish instead of freezing the server", async () => {
    const { reply } = await turn({ lead: [{ call: { name: "search_files", args: { pattern: "(a+)+$" } } }, { content: "Searched another way." }] }, {
      setup: (_workspaceId, files) => writeFile(path.join(files, "long.txt"), `${"a".repeat(40)}!\n`),
    });
    const result = String(requests.at(-1)!.messages.find((message) => message.role === "tool")?.content);
    expect(result).toContain("takes too long");
    expect(reply.text).toBe("Searched another way.");
  });

  it("brings a model up to date on turns another provider answered, even after it was nudged", async () => {
    const first = await turn({ lead: [{ content: "" }, { content: "First answer." }] }, { message: "First question" });
    await turn({ other: [{ content: "Second answer." }] }, { workspaceId: first.workspaceId, provider: "custom", model: "other", message: "Second question" });
    await turn({ lead: [{ content: "Third answer." }] }, { workspaceId: first.workspaceId, message: "Third question" });
    const sent = requests.at(-1)!.messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))).join("\n");
    expect(sent).toContain("Second question");
    expect(sent).toContain("Second answer.");
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

  it("marks a change undone when its own undo_edit reverses it, and clears the mark when that undo is undone", async () => {
    const { undoEdit } = await import("../services/studio/edits.js");
    const { markEditUndone, readAssistantTranscript } = await import("../services/studio/assistant.js");
    const { reply, files, workspaceId } = await turn({
      lead: [
        { call: { name: "write_file", args: { path: "page.html", content: "<h1>v1</h1>" } } },
        { call: { name: "undo_edit", args: { path: "page.html" } } },
        { content: "Took it out again." },
      ],
    });
    const [write, undo] = reply.steps.filter((step) => step.editId);
    expect([write?.undone, undo?.undone]).toEqual([true, undefined]);
    // The person undoes that undo: the page is back, so its change is no longer undone.
    await undoEdit("company-1", workspaceId, { id: undo!.editId }, "you (undo)");
    await markEditUndone("company-1", workspaceId, undo!.editId!);
    expect(await readFile(path.join(files, "page.html"), "utf8")).toBe("<h1>v1</h1>");
    const steps = (await readAssistantTranscript("company-1", workspaceId)).at(-1)!.steps.filter((step) => step.editId);
    expect(steps.map((step) => step.undone)).toEqual([undefined, true]);
  });

  it("shows an earlier turn's change as undone, live, when a later turn undoes it", async () => {
    const { studioHub } = await import("../services/studio/hub.js");
    const { readAssistantTranscript } = await import("../services/studio/assistant.js");
    const first = await turn({ lead: [{ call: { name: "write_file", args: { path: "app.py", content: "print(1)\n" } } }, { content: "Wrote it." }] });
    const sent = vi.spyOn(studioHub, "broadcast");
    try {
      await turn({ lead: [{ call: { name: "undo_edit", args: { path: "app.py" } } }, { content: "Undid it." }] }, { workspaceId: first.workspaceId });
      const earlier = (await readAssistantTranscript("company-1", first.workspaceId)).find((candidate) => candidate.id === first.reply.id)!;
      expect(earlier.steps.find((step) => step.editId)?.undone).toBe(true);
      const events = sent.mock.calls.map(([, event]) => event as { type: string; turn?: StudioAssistantTurn });
      expect(events.some((event) => event.type === "assistant" && event.turn?.id === first.reply.id && event.turn.steps.some((step) => step.undone))).toBe(true);
    } finally {
      sent.mockRestore();
    }
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

  it("keeps each teammate's tokens, the lead's own share, and what the team said to each other", async () => {
    const { reply } = await turn({
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
        { content: "Both parts are in." },
      ],
      "mate-api": [
        { call: { name: "message_team", args: { to: "frontend", message: "The API is at /api/todos" } } },
        { content: "api.py is written." },
      ],
      "mate-ui": [
        { call: { name: "write_file", args: { path: "index.html", content: "<h1>Hi</h1>\n" } } },
        { content: "index.html is written." },
      ],
    }, { team: ["mate-api", "mate-ui"], message: "Build a to-do app" });

    // Two calls each, at 10 input and 2 output tokens a call.
    expect(reply.leadUsage).toMatchObject({ inputTokens: 20, outputTokens: 4 });
    expect(reply.agents?.map((agent) => [agent.model, agent.usage?.inputTokens, agent.usage?.outputTokens])).toEqual([
      ["mate-api", 20, 4],
      ["mate-ui", 20, 4],
    ]);
    expect(reply.usage).toMatchObject({ inputTokens: 60, outputTokens: 12 });

    const api = reply.agents!.find((agent) => agent.model === "mate-api")!;
    const ui = reply.agents!.find((agent) => agent.model === "mate-ui")!;
    const chat = reply.teamChat ?? [];
    expect(chat.filter((message) => message.kind === "task").map((message) => [message.from, message.to, message.text])).toEqual([
      ["lead", api.id, "Write api.py"],
      ["lead", ui.id, "Write index.html"],
    ]);
    expect(chat.find((message) => message.kind === "message")).toMatchObject({ from: api.id, to: ui.id, text: "The API is at /api/todos" });
    expect(chat.filter((message) => message.kind === "report").map((message) => message.from).sort()).toEqual([api.id, ui.id].sort());
    expect(reply.steps.find((step) => step.tool === "message_team")?.summary).toContain(" · Told ");

    // Teammates know the person's request and who else is on the job, and they alone get the team chat tool.
    type WithTools = ChatRequest & { tools?: Array<{ function: { name: string } }> };
    const firstApiCall = requests.find((request) => request.model === "mate-api") as WithTools;
    expect(JSON.stringify(firstApiCall.messages)).toContain("The person asked the lead: Build a to-do app");
    expect(JSON.stringify(firstApiCall.messages)).toContain("Working on this job at the same time");
    expect(firstApiCall.tools?.some((tool) => tool.function.name === "message_team")).toBe(true);
    const leadCall = requests.find((request) => request.model === "lead") as WithTools;
    expect(leadCall.tools?.some((tool) => tool.function.name === "message_team")).toBe(false);

    // The lead hears what they told each other along with the reports.
    const leadFollowUp = requests.filter((request) => request.model === "lead").at(-1)!;
    const teamResult = String(leadFollowUp.messages.find((message) => message.role === "tool")?.content);
    expect(teamResult).toContain("What the teammates told each other");
    expect(teamResult).toContain("The API is at /api/todos");
  });

  it("records a team's spend under each provider and model that did the work", async () => {
    const recorded: StudioAiUsage[] = [];
    await turn({
      lead: [{ call: { name: "ask_teammate", args: { teammate: "mate", task: "Write notes.txt" } } }, { content: "The teammate wrote it." }],
      mate: [{ call: { name: "write_file", args: { path: "notes.txt", content: "hi" } } }, { content: "notes.txt is written." }],
    }, { team: ["mate"], teamProvider: "custom", onUsage: (usage) => { recorded.push(usage); } });
    // Two calls each, at 10 input and 2 output tokens a call.
    expect(recorded.map((usage) => [usage.provider, usage.model, usage.inputTokens, usage.outputTokens]).sort()).toEqual([
      ["custom", "mate", 20, 4],
      ["openai", "lead", 20, 4],
    ]);
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

  const realSetTimeout = globalThis.setTimeout;
  const ndjson = (events: unknown[]) => new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  const refusal = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const busy = refusal(429, { error: "AI provider rate limit exceeded", code: "upstream_rate_limited" });
  const writeCall = () => ndjson([{ type: "tool_use", id: "t1", name: "write_file", input: { path: "hi.txt", content: "hi" } }, { type: "usage", usageDetails: { inputTokens: 3, outputTokens: 1 }, stopReason: "tool_use" }]);
  const wrote = () => ndjson([{ type: "text", text: "Wrote hi.txt." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 3 } }]);

  /** One free-model turn against scripted answers from the service; `during` runs while it works. */
  async function freeTurn(answers: Array<() => Response>, during?: (workspaceId: string) => Promise<void>) {
    const { resetFreeModelHealth } = await import("@paperclipai/shared/puter-ai");
    const { runAssistantTurn, isAssistantRunning, readAssistantTranscript } = await import("../services/studio/assistant.js");
    resetFreeModelHealth();
    const sent: Array<{ messages: Array<{ role: string }>; tools?: unknown[] }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith("https://api.puter.com/")) throw new Error(`Unexpected request to ${url}`);
      sent.push((JSON.parse(String(init?.body)) as { args: (typeof sent)[number] }).args);
      const answer = answers.shift();
      if (!answer) throw new Error("No more scripted answers");
      return answer();
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
      await during?.(workspaceId);
      for (let polls = 0; isAssistantRunning(workspaceId) && polls < 500; polls += 1) await new Promise((resolve) => realSetTimeout(resolve, 20));
      expect(isAssistantRunning(workspaceId)).toBe(false);
      return { reply: (await readAssistantTranscript("company-1", workspaceId)).at(-1)!, sent };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("stops at once while it waits to retry a busy free model", async () => {
    const { stopAssistant } = await import("../services/studio/assistant.js");
    // The wait before the first retry (10 ms under test) never ends by itself here: only Stop can end it.
    let waiting = false;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) => {
      if (ms === 10 && new Error().stack?.includes("runFreeModels")) {
        waiting = true;
        return realSetTimeout(() => undefined, 0);
      }
      return realSetTimeout(callback, ms);
    }) as typeof setTimeout);
    try {
      const { reply } = await freeTurn([busy, busy], async (workspaceId) => {
        for (let polls = 0; !waiting && polls < 500; polls += 1) await new Promise((resolve) => realSetTimeout(resolve, 20));
        stopAssistant(workspaceId);
      });
      expect(waiting).toBe(true);
      expect(reply.error).toBe("Stopped.");
    } finally {
      timers.mockRestore();
    }
  });

  it("keeps the tools and their history through a server error or a dropped connection", async () => {
    const dropped = () => {
      throw new TypeError("fetch failed");
    };
    const { reply, sent } = await freeTurn([writeCall, refusal(503, { error: "Service temporarily unavailable" }), dropped, wrote]);
    expect(reply.error).toBeNull();
    expect(reply.text).toBe("Wrote hi.txt.");
    expect(reply.steps.some((step) => step.summary.includes("did not take the tools"))).toBe(false);
    // The answer after both retries was asked with the tools and the tool turn as they were.
    expect(sent.at(-1)!.tools?.length).toBeGreaterThan(0);
    expect(sent.at(-1)!.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("still sends the tool history as text when the provider refuses it", async () => {
    const { reply, sent } = await freeTurn([writeCall, refusal(400, { error: "AI provider unavailable", code: "upstream_provider_unavailable" }), wrote]);
    expect(reply.text).toBe("Wrote hi.txt.");
    expect(sent.at(-1)!.tools?.length).toBeGreaterThan(0);
    expect(sent.at(-1)!.messages.some((message) => message.role === "tool")).toBe(false);
  });
});

describe("Studio assistant on Anthropic", () => {
  it("keeps answering when the project's prompt and tools change between turns", async () => {
    const { runAssistantTurn, isAssistantRunning, readAssistantTranscript } = await import("../services/studio/assistant.js");
    type Body = {
      system: Array<{ text: string }>;
      tools: Array<{ name: string; description: string; input_schema: unknown }>;
      messages: Array<{ role: string; content: unknown }>;
      thinking?: { block_binding?: { prefix_mismatch_behavior?: string } };
    };
    // Stands in for the API: a thinking block only stays valid in the
    // conversation (prompt, tools, earlier messages) that produced it.
    const binding = (body: Body, before: unknown[]) => createHash("sha256")
      .update(JSON.stringify({ system: body.system.map((block) => block.text), tools: body.tools.map((tool) => [tool.name, tool.description, tool.input_schema]).sort(), before }))
      .digest("hex");
    const refuse = (message: string) => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status: 400, headers: { "content-type": "application/json" } });
    const answer = (signature: string, text: string) => new Response(([
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan the reply." } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
      ["message_stop", { type: "message_stop" }],
    ] as Array<[string, unknown]>).map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    const replies = ["First reply.", "Second reply."];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (!String(url).includes("/v1/messages")) throw new Error(`Unexpected request to ${url}`);
      const body = JSON.parse(String(init?.body)) as Body;
      const betas = (new Headers(init?.headers).get("anthropic-beta") ?? "").split(",");
      const binds = body.thinking?.block_binding;
      if (binds && !betas.includes("thinking-binding-controls-2026-08-01")) return refuse("thinking.block_binding: Extra inputs are not permitted");
      for (const [index, message] of body.messages.entries()) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        const stale = (message.content as Array<{ type: string; signature?: string }>).some((block) => block.type === "thinking" && block.signature !== binding(body, body.messages.slice(0, index)));
        if (stale && binds?.prefix_mismatch_behavior !== "drop_block") {
          return refuse(`messages.${index}.content.0: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.`);
        }
      }
      return answer(binding(body, body.messages), replies.shift() ?? "Done.");
    });
    try {
      const workspaceId = `loop-anthropic-${++workspace}`;
      await mkdir(path.join(root, "company-1", workspaceId, "files"), { recursive: true });
      const credentials = { apiKey: "sk-ant-test", baseUrl: null };
      const send = async (message: string, team?: Array<{ provider: "anthropic"; model: string; credentials: typeof credentials }>) => {
        await runAssistantTurn({
          context: { workspaceId, companyId: "company-1", name: "Demo", language: "python", runCommand: "python main.py", startApp: async () => {}, onFileChanged: async () => {} },
          message,
          provider: "anthropic",
          model: "claude-opus-5-5",
          credentials,
          ...(team ? { team } : {}),
        });
        for (let waited = 0; isAssistantRunning(workspaceId) && waited < 10_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
        return (await readAssistantTranscript("company-1", workspaceId)).at(-1)!;
      };
      expect((await send("Build it")).text).toBe("First reply.");
      // A team added between turns changes the prompt and the tools.
      const second = await send("Now with a team", [{ provider: "anthropic", model: "claude-sonnet-5-5", credentials }]);
      expect(second.error).toBeNull();
      expect(second.text).toBe("Second reply.");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Studio code suggestions", () => {
  it("never sends the server's own Anthropic token to the person's base URL", async () => {
    const { completeCode } = await import("../services/studio/assistant.js");
    const seen: http.IncomingHttpHeaders[] = [];
    const api = http.createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "return 1;" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 } }));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", () => resolve()));
    const saved = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "server-only-token";
    try {
      const completion = await completeCode({
        provider: "anthropic",
        model: "claude-haiku-5-5",
        credentials: { apiKey: "sk-ant-person", baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}` },
        path: "app.js",
        prefix: "function one() {\n  ",
        suffix: "\n}\n",
      });
      expect(completion).toBe("return 1;");
      expect(seen[0]?.["x-api-key"]).toBe("sk-ant-person");
      expect(seen[0]?.authorization).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = saved;
      api.close();
    }
  });

  it("gives up at its time limit even when the editor passes its own signal", async () => {
    const { completeCode } = await import("../services/studio/assistant.js");
    const { resetFreeModelHealth } = await import("@paperclipai/shared/puter-ai");
    resetFreeModelHealth();
    // A provider and a free-model service that never answer.
    const silent = http.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => String(url).startsWith("https://api.puter.com/")
      ? new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
      : realFetch(url, init));
    // The 20-second limit, made short.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), 50);
      return controller.signal;
    });
    try {
      for (const provider of ["openai", "free"] as const) {
        await expect(completeCode({
          provider,
          model: provider === "free" ? "nvidia/nemotron-3.5-lightning:free" : "fast",
          credentials: { apiKey: "sk-test-key", baseUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}/v1` },
          path: "app.js",
          prefix: "const x = ",
          suffix: "",
          signal: new AbortController().signal,
        })).rejects.toThrow(/timed out/i);
      }
    } finally {
      timeout.mockRestore();
      vi.unstubAllGlobals();
      silent.closeAllConnections();
      silent.close();
    }
  });
});
