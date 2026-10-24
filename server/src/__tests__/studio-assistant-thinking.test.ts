import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { studioThinkingLevels, type StudioAiProvider, type StudioThinkingLevel } from "@paperclipai/shared";

/**
 * Stand-ins for the Messages API and an OpenAI-compatible API that record
 * each request and answer with a short reply and no tool calls.
 */
let server: http.Server;
let baseUrl = "";
let root = "";
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "studio-thinking-"));
  process.env.PAPERCLIP_STUDIO_DIR = root;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      requests.push({ url: req.url ?? "", body });
      if (req.url?.includes("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", {
        message: {
          id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Done." } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
      send("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  delete process.env.PAPERCLIP_STUDIO_DIR;
  await rm(root, { recursive: true, force: true });
});

let workspace = 0;
async function ask(provider: StudioAiProvider, model: string, thinking?: StudioThinkingLevel) {
  const { runAssistantTurn, isAssistantRunning } = await import("../services/studio/assistant.js");
  const workspaceId = `ws-${++workspace}`;
  await mkdir(path.join(root, "company-1", workspaceId, "files"), { recursive: true });
  requests.length = 0;
  await runAssistantTurn({
    context: {
      workspaceId,
      companyId: "company-1",
      name: "Demo",
      language: "node",
      runCommand: "npm start",
      startApp: async () => {},
      onFileChanged: async () => {},
    },
    message: "Hello",
    provider,
    model,
    credentials: { apiKey: "sk-test-key", baseUrl: provider === "anthropic" ? baseUrl : `${baseUrl}/v1` },
    ...(thinking ? { thinking } : {}),
  });
  // The turn runs in the background; it is done once it stops counting as running.
  for (let waited = 0; isAssistantRunning(workspaceId) && waited < 5000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isAssistantRunning(workspaceId)).toBe(false);
  return requests[0]!.body;
}

describe("Studio assistant thinking levels", () => {
  it("lists the levels each provider's model takes", () => {
    expect(studioThinkingLevels("anthropic", "claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(studioThinkingLevels("anthropic", "claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(studioThinkingLevels("anthropic", "claude-haiku-4-5")).toEqual([]);
    expect(studioThinkingLevels("openai", "gpt-6.1-sol")).toEqual(["low", "medium", "high"]);
    expect(studioThinkingLevels("openai", "gpt-4o")).toEqual([]);
    expect(studioThinkingLevels("openrouter", "anthropic/claude-opus-5.5")).toEqual(["low", "medium", "high"]);
    expect(studioThinkingLevels("xai", "grok-4.7")).toEqual([]);
  });

  it("thinks deep by default on Claude and uses the level picked", async () => {
    expect((await ask("anthropic", "claude-opus-5-5")).output_config).toEqual({ effort: "high" });

    const max = await ask("anthropic", "claude-opus-5-5", "max");
    expect(max.output_config).toEqual({ effort: "max" });
    // The deepest levels get room to think and still finish.
    expect(max.max_tokens).toBe(64000);

    const quick = await ask("anthropic", "claude-sonnet-5-5", "low");
    expect(quick.output_config).toEqual({ effort: "low" });
    expect(quick.max_tokens).toBe(32000);

    // A level the model does not take falls back to the default.
    expect((await ask("anthropic", "claude-opus-4-6", "xhigh")).output_config).toEqual({ effort: "high" });
  });

  it("sends the level in each provider's own shape, and only where it is taken", async () => {
    const routed = await ask("openrouter", "anthropic/claude-opus-5.5", "high");
    expect(routed.reasoning).toEqual({ effort: "high" });
    expect(routed.reasoning_effort).toBeUndefined();

    const openai = await ask("openai", "gpt-6.1-sol", "medium");
    expect(openai.reasoning_effort).toBe("medium");

    const grok = await ask("xai", "grok-4.7", "high");
    expect(grok.reasoning_effort).toBeUndefined();
    expect(grok.reasoning).toBeUndefined();

    const auto = await ask("openai", "gpt-6.1-sol");
    expect(auto.reasoning_effort).toBeUndefined();
  });
});

describe("Studio assistant activity", () => {
  it("says what a tool is about to do", async () => {
    const { describeActivity } = await import("../services/studio/assistant.js");
    expect(describeActivity("run_command", { command: "npm   install" })).toBe("Running npm install");
    expect(describeActivity("write_file", { path: "src/App.tsx", content: "x" })).toBe("Writing src/App.tsx");
    expect(describeActivity("start_app", {})).toBe("Starting the app");
    expect(describeActivity("run_command", { command: "x".repeat(200) })).toBe(`Running ${"x".repeat(79)}…`);
    expect(describeActivity("mystery", null)).toBe("Working");
  });
});
