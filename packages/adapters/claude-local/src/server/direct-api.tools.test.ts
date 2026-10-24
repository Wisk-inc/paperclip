import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { executeClaudeDirectApi, markConversationCache } from "./direct-api.js";
import { clipOutput, directToolRuntime, globToRegExp, runDirectTool } from "./direct-api-tools.js";

/**
 * A stand-in for the Messages API that first asks for two tools (write a
 * file, then read it back with a command) and, once it has their results,
 * replies.
 */
let server: http.Server;
let baseUrl = "";
const requests: Array<Record<string, unknown>> = [];

function sse(res: http.ServerResponse) {
  return (type: string, data: Record<string, unknown>) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = JSON.parse(body || "{}") as Record<string, unknown>;
      requests.push(json);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = sse(res);
      const messages = json.messages as Array<{ role: string; content: unknown }>;
      const sawResults = JSON.stringify(messages.at(-1)).includes("tool_result");
      send("message_start", {
        message: {
          id: `msg_${requests.length}`, type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
      if (!sawResults && json.tools) {
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Writing the note." } });
        send("content_block_stop", { index: 0 });
        const tool = (index: number, id: string, name: string, input: Record<string, unknown>) => {
          send("content_block_start", { index, content_block: { type: "tool_use", id, name, input: {} } });
          const raw = JSON.stringify(input);
          for (let at = 0; at < raw.length; at += 7) {
            send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: raw.slice(at, at + 7) } });
          }
          send("content_block_stop", { index });
        };
        tool(1, "toolu_write", "Write", { file_path: "notes/hello.txt", content: "hello from the phone\n" });
        tool(2, "toolu_bash", "Bash", { command: "cat notes/hello.txt", description: "Read it back" });
        send("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 200 } });
      } else {
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "I wrote notes/hello.txt and checked it." } });
        send("content_block_stop", { index: 0 });
        send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } });
      }
      send("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function context(config: Record<string, unknown> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "direct-tools-"));
  const logs: string[] = [];
  const ctx = {
    runId: "run-tools",
    agent: { id: "agent-1", companyId: "company-1", name: "Nova", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { model: "claude-opus-5-5", env: { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: baseUrl }, cwd, ...config },
    context: {
      conversationMode: true,
      paperclipIssue: { id: "issue-1", title: "Chat", workMode: "standard" },
      paperclipWake: {
        reason: "issue_commented",
        comments: [{ id: "c1", issueId: "issue-1", body: "Write me a note", bodyTruncated: false, createdAt: null, authorType: "user", authorId: "u1" }],
        commentIds: ["c1"],
      },
    },
    onLog: async (_stream: string, chunk: string) => {
      logs.push(chunk);
    },
  } as unknown as AdapterExecutionContext;
  return { ctx, logs, cwd };
}

describe("direct API engine tools", () => {
  it("runs the tools the model asks for and sends their results back", async () => {
    requests.length = 0;
    const { ctx, logs, cwd } = await context();
    const result = await executeClaudeDirectApi(ctx, "phone");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("I wrote notes/hello.txt and checked it.");
    expect(await fs.readFile(path.join(cwd, "notes/hello.txt"), "utf8")).toBe("hello from the phone\n");

    // Two calls: the tool round and the answer. Usage covers both.
    expect(requests).toHaveLength(2);
    expect(result.usage?.outputTokens).toBe(250);
    const tools = requests[0]!.tools as Array<{ name: string; eager_input_streaming?: boolean }>;
    expect(tools.map((tool) => tool.name)).toEqual(["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Automa"]);
    // A custom base URL might be a gateway, so large inputs are not streamed eagerly there.
    expect(tools.some((tool) => tool.eager_input_streaming)).toBe(false);

    const second = requests[1]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const results = second.at(-1)!.content;
    expect(results.map((block) => block.type)).toEqual(["tool_result", "tool_result"]);
    expect(String(results[1]!.content)).toContain("hello from the phone");
    expect(String(results[1]!.content)).toContain("Exit code 0");
    // The assistant's tool round is replayed as it came back.
    expect(JSON.stringify(second.at(-2))).toContain("toolu_write");

    const events = logs.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { type: string; name?: string });
    expect(events.filter((event) => event.type === "acpx.tool_call").map((event) => event.name)).toEqual(["Write", "Bash"]);
    expect(events.filter((event) => event.type === "acpx.tool_result")).toHaveLength(2);
    expect(String(requests[0]!.system ? JSON.stringify(requests[0]!.system) : "")).toContain("Termux");
  });

  it("answers in text only when tools are turned off", async () => {
    requests.length = 0;
    const { ctx } = await context({ tools: "none" });
    const result = await executeClaudeDirectApi(ctx, "configured");
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools).toBeUndefined();
    expect(JSON.stringify(requests[0]!.system)).toContain("text only");
  });
});

describe("direct API tools", () => {
  async function runtime() {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "direct-tool-"));
    const { ctx } = await context({ cwd });
    return { cwd, rt: directToolRuntime(ctx) };
  }

  it("edits only a unique match unless asked to replace all", async () => {
    const { cwd, rt } = await runtime();
    await fs.writeFile(path.join(cwd, "a.txt"), "one two one\n");
    const twice = await runDirectTool(rt, "Edit", { file_path: "a.txt", old_string: "one", new_string: "1" });
    expect(twice.isError).toBe(true);
    expect(twice.content).toContain("2 times");
    const all = await runDirectTool(rt, "Edit", { file_path: "a.txt", old_string: "one", new_string: "1", replace_all: true });
    expect(all.isError).toBe(false);
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("1 two 1\n");
    const missing = await runDirectTool(rt, "Edit", { file_path: "a.txt", old_string: "zzz", new_string: "y" });
    expect(missing.isError).toBe(true);
  });

  it("reads numbered lines with an offset and searches files", async () => {
    const { cwd, rt } = await runtime();
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src/app.ts"), "const a = 1;\nexport function greet() {}\n");
    await fs.mkdir(path.join(cwd, "node_modules/x"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules/x/index.ts"), "export function greet() {}\n");
    const read = await runDirectTool(rt, "Read", { file_path: "src/app.ts", offset: 2, limit: 1 });
    expect(read.content).toContain("     2\texport function greet() {}");
    expect(read.content).not.toContain("const a");
    const grep = await runDirectTool(rt, "Grep", { pattern: "function greet" });
    expect(grep.content).toBe("src/app.ts:2: export function greet() {}");
    const glob = await runDirectTool(rt, "Glob", { pattern: "**/*.ts" });
    expect(glob.content).toBe("src/app.ts");
  });

  it("stops a command that runs too long and reports bad input", async () => {
    const { rt } = await runtime();
    const slow = await runDirectTool(rt, "Bash", { command: "sleep 5", timeout: 1 });
    expect(slow.isError).toBe(true);
    expect(slow.content).toContain("Stopped after 1 seconds");
    expect((await runDirectTool(rt, "Read", null)).content).toContain("INVALID_JSON");
    expect((await runDirectTool(rt, "Nope", {})).isError).toBe(true);
    expect((await runDirectTool(rt, "Automa", { method: "GET", path: "/etc/passwd" })).isError).toBe(true);
  });

  it("matches globs and clips long output at both ends", () => {
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    const clipped = clipOutput(`${"a".repeat(100)}${"b".repeat(100)}`, 40);
    expect(clipped.startsWith("a".repeat(20))).toBe(true);
    expect(clipped.endsWith("b".repeat(20))).toBe(true);
  });

  it("keeps a single moving cache point on the newest message", () => {
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi", cache_control: { type: "ephemeral" as const } }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "using a tool" }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t", content: "ok" }] },
    ];
    markConversationCache(messages);
    expect(JSON.stringify(messages[0])).not.toContain("cache_control");
    expect(JSON.stringify(messages[2])).toContain("cache_control");
  });
});
