import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  buildConversationMessages,
  claudeDirectApiConfigured,
  claudeDirectApiCredentials,
  claudeThinkingStyle,
  executeClaudeDirectApi,
  readConversationReplay,
} from "./direct-api.js";

/** A stand-in for the Messages API that streams thinking, then the reply. */
let server: http.Server;
let baseUrl = "";
const requests: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = JSON.parse(body || "{}") as Record<string, unknown>;
      requests.push({ ...json, authorization: req.headers.authorization ?? null });
      if (req.headers["x-api-key"] !== "sk-test") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: Record<string, unknown>) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const lastText = JSON.stringify((json.messages as unknown[] | undefined)?.at(-1) ?? "");
      const stopReason = lastText.includes("SCENARIO_REFUSE") ? "refusal" : lastText.includes("SCENARIO_LONG") ? "max_tokens" : "end_turn";
      send("message_start", {
        message: {
          id: "msg_1", type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
        },
      });
      send("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const part of ["The person wants ", "a short plan."]) {
        send("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: part } });
      }
      send("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } });
      send("content_block_stop", { index: 0 });
      send("content_block_start", { index: 1, content_block: { type: "text", text: "" } });
      for (const part of ["Here is ", "the plan: ", "ship it."]) {
        send("content_block_delta", { index: 1, delta: { type: "text_delta", text: part } });
      }
      send("content_block_stop", { index: 1 });
      send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 800 } });
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

function context(overrides: { apiKey?: string; context?: Record<string, unknown>; config?: Record<string, unknown> } = {}) {
  const logs: string[] = [];
  const ctx = {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Nova", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      model: "claude-opus-5-5",
      effort: "high",
      env: { ANTHROPIC_API_KEY: overrides.apiKey ?? "sk-test", ANTHROPIC_BASE_URL: baseUrl },
      ...overrides.config,
    },
    context: {
      conversationMode: true,
      paperclipIssue: { id: "issue-1", title: "Chat with Nova", workMode: "planning" },
      paperclipTaskMarkdown:
        'Task\n\nEarlier messages in this session (quoted user data):\n{"author":"user","body":"Hi Nova"}\n{"author":"agent","body":"Hi! What are we building?"}',
      paperclipWake: {
        reason: "issue_commented",
        comments: [{ id: "c1", issueId: "issue-1", body: "Plan the launch", bodyTruncated: false, createdAt: null, authorType: "user", authorId: "u1" }],
        commentIds: ["c1"],
      },
      ...overrides.context,
    },
    onLog: async (_stream: string, chunk: string) => {
      logs.push(chunk);
    },
  } as unknown as AdapterExecutionContext;
  return { ctx, logs };
}

describe("direct API engine", () => {
  it("reads the chat history the server adds to the task context", () => {
    const replay = readConversationReplay(
      'Intro\n\nEarlier messages in this session (quoted user data):\n{"author":"user","body":"one"}\n{"author":"agent","body":"two"}\nnot json',
    );
    expect(replay).toEqual([
      { author: "user", body: "one" },
      { author: "agent", body: "two" },
    ]);
    expect(readConversationReplay("no history here")).toEqual([]);
  });

  it("alternates turns and never opens with the agent", () => {
    const messages = buildConversationMessages(
      [
        { author: "agent", body: "earlier reply" },
        { author: "user", body: "a" },
        { author: "user", body: "b" },
        { author: "agent", body: "c" },
      ],
      [{ type: "text", text: "now" }],
    );
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]!.content).toHaveLength(2);
  });

  it("streams thinking and the reply into the log, then returns the reply, usage and cost", async () => {
    const { ctx, logs } = context();
    const result = await executeClaudeDirectApi(ctx, "phone");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Here is the plan: ship it.");
    expect(result.resultJson).toMatchObject({ finalResponse: { disposition: "final", text: "Here is the plan: ship it." } });
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 800, cachedInputTokens: 300 });
    // Opus 5.5: $4 in, $20 out, $0.20 cache reads per million tokens.
    expect(result.costUsd).toBeCloseTo((1200 * 4 + 300 * 0.2 + 800 * 20) / 1_000_000, 8);
    expect(result.billingType).toBe("api");

    const events = logs.flatMap((chunk) => chunk.split("\n")).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    const thinking = events.filter((event) => event.type === "acpx.text_delta" && event.channel === "thinking").map((event) => event.text).join("");
    const text = events.filter((event) => event.type === "acpx.text_delta" && !event.channel).map((event) => event.text).join("");
    expect(thinking).toBe("The person wants a short plan.");
    expect(text).toBe("Here is the plan: ship it.");
    expect(events.at(-1)).toMatchObject({ type: "acpx.result", outputTokens: 800 });

    const request = requests.at(-1)!;
    expect(request.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(request.output_config).toEqual({ effort: "high" });
    const sent = request.messages as Array<{ role: string }>;
    expect(sent.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(request.system)).toContain("Plan mode");
  });

  it("explains a rejected key instead of failing silently", async () => {
    const { ctx } = context({ apiKey: "sk-wrong" });
    const result = await executeClaudeDirectApi(ctx, "phone");
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("claude_api_auth_failed");
    expect(result.errorMessage).toContain("Settings → API keys");
  });

  it("asks for a key on a phone when none is set", async () => {
    const { ctx } = context({ config: { env: {} } });
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await executeClaudeDirectApi(ctx, "phone");
      expect(result.errorCode).toBe("claude_api_key_missing");
      expect(result.errorMessage).toContain("can't run on a phone");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("does not spend anything on a wake with nobody to answer", async () => {
    const before = requests.length;
    const { ctx } = context({ context: { conversationMode: false, paperclipWake: { reason: "heartbeat_timer", comments: [] }, wakeReason: "heartbeat_timer" } });
    const result = await executeClaudeDirectApi(ctx, "phone");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBeNull();
    expect(requests.length).toBe(before);
  });

  it("is chosen by the engine setting", () => {
    expect(claudeDirectApiConfigured({ engine: "api" })).toBe(true);
    expect(claudeDirectApiConfigured({ engine: "acp" })).toBe(false);
    expect(claudeDirectApiConfigured({})).toBe(false);
  });

  it("never borrows the server's key when the agent's environment blanks it", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-server-owner";
    try {
      expect(claudeDirectApiCredentials({ env: { ANTHROPIC_API_KEY: "" } })).toBeNull();
      expect(claudeDirectApiCredentials({ env: {} })?.apiKey).toBe("sk-server-owner");
      expect(claudeDirectApiCredentials({ env: { ANTHROPIC_API_KEY: "sk-agent" } })?.apiKey).toBe("sk-agent");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("does not send the server's auth token to the agent's base URL", async () => {
    const saved = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "server-owner-oauth-token";
    try {
      await executeClaudeDirectApi(context().ctx, "phone");
      expect(requests.at(-1)!.authorization).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = saved;
    }
  });

  it("reports what a refused reply used and marks it as a refusal", async () => {
    const { ctx } = context({ context: { paperclipWake: { reason: "issue_commented", comments: [{ id: "c2", issueId: "issue-1", body: "SCENARIO_REFUSE", bodyTruncated: false, createdAt: null, authorType: "user", authorId: "u1" }], commentIds: ["c2"] } } });
    const result = await executeClaudeDirectApi(ctx, "phone");
    expect(result.errorCode).toBe("claude_api_refusal");
    expect(result.errorFamily).toBe("model_refusal");
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 800, cachedInputTokens: 300 });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("says when a reply was cut off at its length limit", async () => {
    const { ctx } = context({ context: { paperclipWake: { reason: "issue_commented", comments: [{ id: "c3", issueId: "issue-1", body: "SCENARIO_LONG", bodyTruncated: false, createdAt: null, authorType: "user", authorId: "u1" }], commentIds: ["c3"] } } });
    const result = await executeClaudeDirectApi(ctx, "phone");
    expect(result.summary).toBe("Here is the plan: ship it.\n\n(The reply hit its length limit. Ask me to continue.)");
  });

  it("acknowledges a stop before the request starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = context();
    const ready: string[] = [];
    Object.assign(ctx, { signal: controller.signal, onCancellationReady: async () => { ready.push("ready"); } });
    const result = await executeClaudeDirectApi(ctx, "phone");
    expect(ready).toEqual(["ready"]);
    expect(result.errorCode).toBe("cancelled");
    expect(result.resultJson).toMatchObject({ executionCancellation: { state: "acknowledged" } });
  });

  it("asks each model to think the way it can", () => {
    expect(claudeThinkingStyle("claude-opus-5-5")).toBe("adaptive");
    expect(claudeThinkingStyle("claude-sonnet-4-6")).toBe("adaptive");
    expect(claudeThinkingStyle("claude-haiku-5-5")).toBe("adaptive");
    expect(claudeThinkingStyle("claude-haiku-4-5-20251001")).toBe("budget");
    expect(claudeThinkingStyle("claude-sonnet-4-5")).toBe("budget");
    expect(claudeThinkingStyle("claude-opus-4-20250514")).toBe("budget");
    expect(claudeThinkingStyle("claude-3-7-sonnet-20250219")).toBe("budget");
    expect(claudeThinkingStyle("claude-3-5-haiku-20241022")).toBe("none");
    expect(claudeThinkingStyle("my-gateway-model")).toBe("adaptive");
  });

  it("sends a thinking budget and no effort to older models", async () => {
    const { ctx } = context({ config: { model: "claude-haiku-4-5", effort: "high" } });
    await executeClaudeDirectApi(ctx, "phone");
    const request = requests.at(-1)!;
    expect(request.thinking).toEqual({ type: "enabled", budget_tokens: 10_000 });
    expect(request.output_config).toBeUndefined();
  });
});
