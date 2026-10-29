import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../types.js";
import { resetFreeModelHealth } from "@paperclipai/shared/puter-ai";

vi.mock("../../services/free-models.js", () => ({
  equivalentTokenCostUsd: vi.fn(async () => 0.001),
  equivalentImageCostUsd: (images: number) => images * 0.002,
}));

const { execute } = await import("./execute.js");

/** The document tools every chat model gets, after whatever its toggles allow. */
const OFFICE_TOOL_NAMES = ["CreateSpreadsheet", "CreatePresentation", "CreateDocument", "ReadDocument"];

const API = "http://automa.test";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function ndjson(lines: Record<string, unknown>[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

/** `chatTurns` is the NDJSON event list for each streamed chat turn, in order. */
function stubNetwork(options: { chatTurns?: Record<string, unknown>[][]; commentReply?: string } = {}) {
  const calls: Call[] = [];
  const turns = options.chatTurns ?? [[{ type: "text", text: options.commentReply ?? "Hello there." }, { type: "usage", usageDetails: { inputTokens: 40, outputTokens: 60 } }]];
  let chatTurn = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.puter.com/")) {
      const request = JSON.parse(String(init.body)) as { interface: string; args?: { stream?: boolean } };
      if (request.interface === "puter-image-generation") return json({ success: true, result: `data:image/png;base64,${JPEG}` });
      if (request.args?.stream) return ndjson(turns[Math.min(chatTurn++, turns.length - 1)]!);
      // Non-streaming (vision describe / fallback).
      return json({ success: true, result: { message: { content: "A fox in the snow at night." }, usageDetails: { inputTokens: 10, outputTokens: 20 } } });
    }
    if (url === `${API}/api/issues/issue-1`) return json({ companyId: "company-1", title: "Chat", conversationAgentId: "agent-1" });
    if (url.startsWith(`${API}/api/issues/issue-1/comments`) && method === "GET") {
      return json([
        { id: "c1", authorType: "user", authorAgentId: null, body: "How many apples are left?" },
        { id: "c0", authorType: "system", authorAgentId: null, body: "Run failed" },
        { id: "a0", authorType: "agent", authorAgentId: "agent-1", body: "Hi, I am Atlas." },
        { id: "u0", authorType: "user", authorAgentId: null, body: "Hello" },
      ]);
    }
    if (url === `${API}/api/issues/issue-1/attachments`) return json([]);
    if (url === `${API}/api/agents/me`) return json({ id: "agent-1", name: "Atlas" });
    if (url === `${API}/api/companies/company-1/issues/issue-1/attachments` && method === "POST") return json({ id: "att-1", contentPath: "/api/attachments/att-1/content" });
    if (url === `${API}/api/issues/issue-1/comments` && method === "POST") return json({ id: "reply" });
    return new Response("not found", { status: 404 });
  }));
  return { calls, puterBodies: () => calls.filter((c) => c.url.startsWith("https://api.puter.com/")).map((c) => JSON.parse(String(c.body)) as { args: Record<string, unknown> }) };
}

function context(config: Record<string, unknown>, authToken: string | null = "run-token"): AdapterExecutionContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    runId: "run-12345678",
    agent: { id: "agent-1", companyId: "company-1", name: "Atlas", adapterType: "free_models", adapterConfig: config },
    runtime: {} as AdapterExecutionContext["runtime"],
    config,
    context: { issueId: "issue-1", PAPERCLIP_API_URL: API },
    authToken: authToken ?? undefined,
    onLog: async (_stream, chunk) => { logs.push(chunk); },
  } as AdapterExecutionContext & { logs: string[] };
}

beforeEach(() => { process.env.PAPERCLIP_API_URL = API; resetFreeModelHealth(); });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.PAPERCLIP_API_URL; });

function postedBody(calls: Call[]): string {
  const post = calls.find((call) => call.method === "POST" && call.url === `${API}/api/issues/issue-1/comments`);
  return JSON.parse(String(post!.body)).body as string;
}

describe("free models engine", () => {
  it("streams a reply, shows thinking at a set level, and records free usage", async () => {
    const net = stubNetwork({ chatTurns: [[
      { type: "reasoning", reasoning: "3 x 12 = 36; 36 - 7 = 29." },
      { type: "text", text: "29 apples." },
      { type: "usage", usageDetails: { inputTokens: 40, outputTokens: 60 }, stopReason: "end_turn" },
    ]] });
    const ctx = context({ model: "deepseek/deepseek-v4.1-flash:free", effort: "high", freeFiles: false, freeTeammates: false, freeWeb: false, freeConnections: false });
    const result = await execute(ctx);

    const sent = net.puterBodies()[0]!.args as { messages: Array<{ role: string; content: string }>; stream: boolean };
    expect(sent.stream).toBe(true);
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    // Asked who made the app, the agent knows; it never credits the app's maker with the model.
    expect(sent.messages[0]!.content).toContain("Automa was made in Jamaica by Nathan Lyttle (Corx Labs)");
    expect(sent.messages[0]!.content).toContain("The AI model you run on was made by its own maker, not by Nathan Lyttle");
    expect(sent.messages.at(-1)!.content).toContain("Think step by step carefully");
    expect(postedBody(net.calls)).toBe("29 apples.");
    expect(ctx.logs.some((line) => line.includes('"channel":"thinking"'))).toBe(true);
    expect(result).toMatchObject({ exitCode: 0, costUsd: 0, provider: "free_models", usage: { inputTokens: 40, outputTokens: 60 }, resultJson: { freeUsage: { images: 0, equivalentUsd: 0.001 } } });
  });

  it("streams a tag-based model's thinking to the panel, not the reply", async () => {
    const net = stubNetwork({ chatTurns: [[
      { type: "text", text: "<thinking>3 x 12 = 36; minus 7 is 29.</thinking>29 apples." },
      { type: "usage", usageDetails: { inputTokens: 8, outputTokens: 12 } },
    ]] });
    const ctx = context({ model: "deepseek/deepseek-v4.1-flash:free", effort: "high", freeFiles: false, freeTeammates: false, freeWeb: false, freeConnections: false });
    await execute(ctx);
    expect(postedBody(net.calls)).toBe("29 apples.");
    const thinkingDeltas = ctx.logs.filter((line) => line.includes('"channel":"thinking"')).map((line) => JSON.parse(line).text).join("");
    expect(thinkingDeltas).toBe("3 x 12 = 36; minus 7 is 29.");
    const textDeltas = ctx.logs.filter((line) => line.includes('acpx.text_delta') && !line.includes('"channel"')).map((line) => JSON.parse(line).text).join("");
    expect(textDeltas).toBe("29 apples.");
  });

  it("keeps thinking out of the reply on Auto", async () => {
    const net = stubNetwork({ chatTurns: [[{ type: "reasoning", reasoning: "quiet" }, { type: "text", text: "29 apples." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 5 } }]] });
    await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", freeFiles: false, freeTeammates: false, freeWeb: false, freeConnections: false }));
    expect(postedBody(net.calls)).toBe("29 apples.");
  });

  it("runs a tool the model asks for and feeds the result back", async () => {
    const net = stubNetwork({ chatTurns: [
      [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "t1", name: "Automa", input: { method: "GET", path: "/api/agents/me" } }, { type: "usage", usageDetails: { inputTokens: 30, outputTokens: 10 }, stopReason: "tool_use" }],
      [{ type: "text", text: "You are Atlas." }, { type: "usage", usageDetails: { inputTokens: 50, outputTokens: 8 }, stopReason: "end_turn" }],
    ] });
    const result = await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", freeFiles: false, freeWeb: false, freeConnections: false }));

    expect(net.calls.some((call) => call.url === `${API}/api/agents/me`)).toBe(true);
    const followUp = net.puterBodies()[1]!.args as { messages: Array<{ role: string }> };
    expect(followUp.messages.map((m) => m.role)).toContain("tool");
    expect(postedBody(net.calls)).toBe("You are Atlas.");
    expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 18 });
  });

  /** A fetch stub whose free-model calls answer from a list of responses, in order; the last one repeats. */
  function stubPuter(responses: Array<() => Response>) {
    const calls: Call[] = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? "GET", headers: {}, body: init.body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("https://api.puter.com/")) return responses[Math.min(n++, responses.length - 1)]!();
      if (url === `${API}/api/issues/issue-1`) return json({ companyId: "company-1", title: "Chat", conversationAgentId: "agent-1" });
      if (url.startsWith(`${API}/api/issues/issue-1/comments`) && (init.method ?? "GET") === "GET") return json([{ id: "c1", authorType: "user", authorAgentId: null, body: "Hi" }]);
      if (url === `${API}/api/issues/issue-1/comments`) return json({ id: "reply" });
      if (url === `${API}/api/agents/me`) return json({ id: "agent-1", name: "Atlas" });
      return new Response("nf", { status: 404 });
    }));
    const puterModels = () => calls.filter((c) => c.url.startsWith("https://api.puter.com/")).map((c) => (JSON.parse(String(c.body)) as { args: { model: string } }).args.model);
    const posted = () => JSON.parse(String(calls.find((c) => c.url === `${API}/api/issues/issue-1/comments` && c.method === "POST")!.body)).body as string;
    return { calls, puterModels, posted };
  }
  const refusal = (status: number, body: Record<string, unknown>) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const NEMOTRON = "nvidia/nemotron-3-ultra-550b-a55b:free";
  const NO_TOOLS = { freeFiles: false, freeWeb: false, freeConnections: false, freeTeammates: false, imageModel: "none" };

  /** A chat with the given comments (newest first), attachments and teammates; free-model calls answer from `turns` in order, the last repeating. */
  function stubThread(options: { comments: Array<Record<string, unknown>>; attachments?: Array<Record<string, unknown>>; agents?: Array<Record<string, unknown>>; turns: Array<() => Response> }) {
    const calls: Call[] = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      // Like a real fetch, a cancelled run's requests fail at once.
      if (init.signal?.aborted) throw init.signal.reason;
      const url = String(input);
      const method = init.method ?? "GET";
      calls.push({ url, method, headers: {}, body: init.body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("https://api.puter.com/")) return options.turns[Math.min(n++, options.turns.length - 1)]!();
      if (url === `${API}/api/issues/issue-1`) return json({ companyId: "company-1", title: "Chat", conversationAgentId: "agent-1" });
      if (url.startsWith(`${API}/api/issues/issue-1/comments`) && method === "GET") return json(options.comments);
      if (url === `${API}/api/issues/issue-1/attachments`) return json(options.attachments ?? []);
      if (url === `${API}/api/companies/company-1/issues/issue-1/attachments` && method === "POST") return json({ id: "att-9", contentPath: "/api/attachments/att-9/content" });
      if (url.startsWith(`${API}/api/attachments/`)) return new Response(Buffer.from(JPEG, "base64"), { status: 200, headers: { "content-type": "image/jpeg" } });
      if (url === `${API}/api/companies/company-1/agents`) return json(options.agents ?? []);
      if (url === `${API}/api/agents/me`) return json({ id: "agent-1", name: "Atlas" });
      if (url === `${API}/api/issues/issue-1/comments`) return json({ id: "reply" });
      return new Response("nf", { status: 404 });
    }));
    const sent = () => calls.filter((c) => c.url.startsWith("https://api.puter.com/")).map((c) => (JSON.parse(String(c.body)) as { args: { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] } }).args);
    const posted = () => JSON.parse(String(calls.find((c) => c.url === `${API}/api/issues/issue-1/comments` && c.method === "POST")!.body)).body as string;
    return { calls, sent, posted };
  }

  it("keeps the chosen model and retries it when the provider is busy", async () => {
    const net = stubPuter([
      refusal(429, { error: "AI provider rate limit exceeded", code: "upstream_rate_limited" }),
      () => ndjson([{ type: "text", text: "Back now." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 2 } }]),
    ]);
    await execute(context({ model: NEMOTRON, ...NO_TOOLS }));
    expect(net.puterModels()).toEqual([NEMOTRON, NEMOTRON]);
    expect(net.posted()).toBe("Back now.");
  });

  it("asks the same model again when a reply comes back empty, then for words without tools", async () => {
    const empty = () => ndjson([{ type: "usage", usageDetails: { inputTokens: 5, outputTokens: 0 } }]);
    const net = stubPuter([empty, empty, () => ndjson([{ type: "text", text: "It's 31°C in Kingston." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 6 } }])]);
    await execute(context({ model: NEMOTRON, freeFiles: false, freeWeb: false, freeConnections: false, imageModel: "none" }));
    expect(net.puterModels()).toEqual([NEMOTRON, NEMOTRON, NEMOTRON]);
    const bodies = net.calls.filter((c) => c.url.startsWith("https://api.puter.com/")).map((c) => JSON.parse(String(c.body)) as { args: { tools?: unknown[]; messages: Array<{ role: string; content: unknown }> } });
    expect(bodies[1]!.args.tools?.length).toBeGreaterThan(0);
    // The last try asks for words only, joined to the person's own message (no two user turns in a row).
    expect(bodies[2]!.args.tools).toBeUndefined();
    const lastTurn = bodies[2]!.args.messages.at(-1)!;
    expect(lastTurn.role).toBe("user");
    expect(String(lastTurn.content)).toContain("Your last reply came back empty");
    expect(net.posted()).toBe("It's 31°C in Kingston.");
  });

  it("runs a tool call the model wrote as text instead of posting it", async () => {
    const net = stubPuter([
      () => ndjson([{ type: "text", text: 'Automa(method="GET", path="/api/agents/me") </tool_call>' }, { type: "usage", usageDetails: { inputTokens: 3, outputTokens: 4 } }]),
      () => ndjson([{ type: "text", text: "You are Atlas." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 2 } }]),
    ]);
    await execute(context({ model: "openrouter/free", freeFiles: false, freeWeb: false, freeConnections: false, imageModel: "none" }));
    expect(net.calls.some((call) => call.url === `${API}/api/agents/me`)).toBe(true);
    expect(net.posted()).toBe("You are Atlas.");
  });

  it("gives a busy model its retries again after each answer in a long run", async () => {
    const busy = refusal(429, { error: "AI provider rate limit exceeded", code: "upstream_rate_limited" });
    const call = () => ndjson([{ type: "tool_use", id: `t${Math.random()}`, name: "Automa", input: { method: "GET", path: "/api/agents/me" } }, { type: "usage", usageDetails: { inputTokens: 3, outputTokens: 1 }, stopReason: "tool_use" }]);
    const answer = () => ndjson([{ type: "text", text: "Done." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 2 } }]);
    // Three busy refusals before each of three turns: nine in all, more than one run's worth if they added up.
    const net = stubPuter([busy, busy, busy, call, busy, busy, busy, call, busy, busy, busy, answer]);
    await execute(context({ model: NEMOTRON, freeFiles: false, freeWeb: false, freeConnections: false, imageModel: "none" }));
    expect(net.posted()).toBe("Done.");
    // A rate limit leaves the tool history in its native shape.
    const last = JSON.parse(String(net.calls.filter((c) => c.url.startsWith("https://api.puter.com/")).at(-1)!.body)) as { args: { messages: Array<{ role: string }> } };
    expect(last.args.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("says at once when the model is at its daily limit, and when it is back, without retrying", async () => {
    const net = stubPuter([
      refusal(429, { error: "AI provider rate limit exceeded", code: "upstream_rate_limited", attempts: [{ status: 429, error: "429 Free model daily limit exceeded (1000 requests per day). Please try again after 600 seconds." }] }),
    ]);
    const outcome = await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", ...NO_TOOLS })).then((r) => r.errorMessage ?? "", (e: Error) => e.message);
    expect(net.puterModels()).toEqual(["deepseek/deepseek-v4.1-flash:free"]);
    expect(outcome).toContain("DeepSeek V4.1 Flash has used up today's free requests");
    expect(outcome).toContain("back in about 10 minutes");
  });

  it("asks Content Safety without tools and answers with a readable verdict", async () => {
    const net = stubPuter([
      () => ndjson([{ type: "text", text: "User Safety: safe" }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 4 } }]),
    ]);
    await execute(context({ model: "nvidia/nemotron-3.5-content-safety:free", imageModel: "none" }));
    expect(net.calls.filter((c) => c.url.startsWith("https://api.puter.com/")).map((c) => (JSON.parse(String(c.body)) as { args: { tools?: unknown } }).args.tools)).toEqual([undefined]);
    expect(net.posted()).toBe("**Safety check: safe.** Nothing harmful found in the message.");
  });

  it("never switches to another model when the chosen one keeps refusing, and says which refused", async () => {
    const net = stubPuter([
      refusal(400, { error: "AI provider unavailable", code: "upstream_provider_unavailable", attempts: [{ status: 400, error: "400 Provider returned error", upstreamMessage: "Provider returned error" }] }),
    ]);
    const outcome = await execute(context({ model: NEMOTRON, ...NO_TOOLS })).then((r) => r.errorMessage ?? "", (e: Error) => e.message);
    expect(new Set(net.puterModels())).toEqual(new Set([NEMOTRON]));
    expect(outcome).toContain("Nemotron 3 Ultra 550B");
    expect(outcome).toContain("Provider returned error");
    expect(outcome).not.toMatch(/instead|switched|fell back/i);
  });

  it("sends a tool turn with text in it, which strict providers require", async () => {
    const net = stubNetwork({ chatTurns: [
      [{ type: "tool_use", id: "t1", name: "Automa", input: { method: "GET", path: "/api/agents/me" } }, { type: "usage", usageDetails: { inputTokens: 30, outputTokens: 10 }, stopReason: "tool_use" }],
      [{ type: "text", text: "You are Atlas." }, { type: "usage", usageDetails: { inputTokens: 50, outputTokens: 8 }, stopReason: "end_turn" }],
    ] });
    await execute(context({ model: NEMOTRON, freeFiles: false, freeWeb: false, freeConnections: false, imageModel: "none" }));
    const followUp = net.puterBodies()[1]!.args as { messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }> };
    const toolTurn = followUp.messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(typeof toolTurn?.content === "string" && toolTurn.content.trim().length > 0).toBe(true);
  });

  it("resends the tool history as text when the provider refuses it, on the same model", async () => {
    const net = stubPuter([
      () => ndjson([{ type: "tool_use", id: "t1", name: "Automa", input: { method: "GET", path: "/api/agents/me" } }, { type: "usage", usageDetails: { inputTokens: 3, outputTokens: 1 }, stopReason: "tool_use" }]),
      refusal(400, { error: "AI provider unavailable", code: "upstream_provider_unavailable" }),
      () => ndjson([{ type: "text", text: "You are Atlas." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 2 } }]),
    ]);
    await execute(context({ model: NEMOTRON, freeFiles: false, freeWeb: false, freeConnections: false, imageModel: "none" }));
    expect(net.puterModels()).toEqual([NEMOTRON, NEMOTRON, NEMOTRON]);
    const third = JSON.parse(String(net.calls.filter((c) => c.url.startsWith("https://api.puter.com/"))[2]!.body)) as { args: { messages: Array<{ role: string; content: unknown }> } };
    expect(third.args.messages.some((m) => m.role === "tool")).toBe(false);
    expect(third.args.messages.some((m) => m.role === "user" && String(m.content).includes("[Automa result]"))).toBe(true);
    expect(net.posted()).toBe("You are Atlas.");
  });

  it("cuts a loop of identical tool calls short", async () => {
    const same = () => ndjson([{ type: "tool_use", id: `t${Math.random()}`, name: "Automa", input: { method: "GET", path: "/api/agents/me" } }, { type: "usage", usageDetails: { inputTokens: 3, outputTokens: 1 }, stopReason: "tool_use" }]);
    const net = stubPuter([same, same, same, same, same, () => ndjson([{ type: "text", text: "Done looking." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 2 } }])]);
    await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", freeFiles: false, freeWeb: false, freeConnections: false, imageModel: "none" }));
    // Two real tool runs (plus the profile lookup every run starts with); the
    // rest were answered without running the tool again.
    expect(net.calls.filter((c) => c.url === `${API}/api/agents/me`).length).toBe(3);
    expect(net.posted()).toBe("Done looking.");
  });

  it("starts over after /new: the model sees only what came after it", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? "GET", headers: {}, body: init.body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("https://api.puter.com/")) return ndjson([{ type: "text", text: "Fresh start." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 2 } }]);
      if (url === `${API}/api/issues/issue-1`) return json({ companyId: "company-1", title: "Chat", conversationAgentId: "agent-1" });
      if (url.startsWith(`${API}/api/issues/issue-1/comments`) && (init.method ?? "GET") === "GET") return json([
        { id: "c3", authorType: "user", authorAgentId: null, body: "What did I say first?" },
        { id: "c2", authorType: "user", authorAgentId: null, body: "/new" },
        { id: "a1", authorType: "agent", authorAgentId: "agent-1", body: "Noted: the password is tiger." },
        { id: "c1", authorType: "user", authorAgentId: null, body: "The password is tiger." },
      ]);
      if (url === `${API}/api/issues/issue-1/comments`) return json({ id: "reply" });
      return new Response("nf", { status: 404 });
    }));
    await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", ...NO_TOOLS }));
    const sent = JSON.parse(String(calls.find((c) => c.url.startsWith("https://api.puter.com/"))!.body)) as { args: { messages: Array<{ role: string; content: unknown }> } };
    const texts = sent.args.messages.map((m) => String(m.content));
    expect(texts.some((t) => t.includes("tiger"))).toBe(false);
    expect(texts.some((t) => t === "/new")).toBe(false);
    expect(texts.some((t) => t.startsWith("What did I say first?"))).toBe(true);
  });

  it("drops tools and answers in text when the model can't take them", async () => {
    const calls: Call[] = [];
    let streamCall = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? "GET", headers: {}, body: init.body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("https://api.puter.com/")) {
        streamCall += 1;
        if (streamCall === 1) return new Response(JSON.stringify({ success: false, error: "Model does not support tools" }), { status: 400, headers: { "content-type": "application/json" } });
        return ndjson([{ type: "text", text: "Plain answer." }, { type: "usage", usageDetails: { inputTokens: 12, outputTokens: 4 } }]);
      }
      if (url === `${API}/api/issues/issue-1`) return json({ companyId: "company-1", title: "Chat", conversationAgentId: "agent-1" });
      if (url.startsWith(`${API}/api/issues/issue-1/comments`) && (init.method ?? "GET") === "GET") return json([{ id: "c1", authorType: "user", authorAgentId: null, body: "Hi" }]);
      if (url === `${API}/api/issues/issue-1/comments`) return json({ id: "reply" });
      return new Response("nf", { status: 404 });
    }));
    const result = await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", freeFiles: false, freeTeammates: false, freeConnections: false }));
    expect(JSON.parse(String(calls.find((c) => c.url === `${API}/api/issues/issue-1/comments` && c.method === "POST")!.body)).body).toBe("Plain answer.");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
  });

  it("offers GenerateImage with nothing paired and draws when the model calls it", async () => {
    // A first agent hired with no image model chosen still draws: the default
    // pairing is on, and the prompt tells the model to draw when asked.
    const net = stubNetwork({ chatTurns: [
      [{ type: "tool_use", id: "t1", name: "GenerateImage", input: { prompt: "a red fox in snow at night, cinematic" } }, { type: "usage", usageDetails: { inputTokens: 30, outputTokens: 10 }, stopReason: "tool_use" }],
      [{ type: "text", text: "Here is your fox." }, { type: "usage", usageDetails: { inputTokens: 50, outputTokens: 8 }, stopReason: "end_turn" }],
    ] });
    const result = await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", freeFiles: false, freeWeb: false, freeConnections: false, freeTeammates: false }));

    const first = net.puterBodies()[0]!.args as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> };
    expect(first.tools?.map((tool) => tool.function.name)).toEqual(["GenerateImage", ...OFFICE_TOOL_NAMES]);
    expect(first.messages[0]!.content).toContain("call GenerateImage");
    expect(net.calls.some((call) => call.url.endsWith("/attachments") && call.method === "POST")).toBe(true);
    expect(postedBody(net.calls)).toContain("![a red fox in snow at night, cinematic](/api/attachments/att-1/content)");
    expect(result.resultJson).toMatchObject({ freeUsage: { images: 1 } });
  });

  it("offers no GenerateImage when the pairing is switched off", async () => {
    const net = stubNetwork();
    await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", imageModel: "none", freeFiles: false, freeWeb: false, freeConnections: false, freeTeammates: false }));
    const first = net.puterBodies()[0]!.args as { tools?: unknown[] };
    expect(((first.tools ?? []) as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual(OFFICE_TOOL_NAMES);
  });

  it("draws with an image model, uploads the picture, and embeds it", async () => {
    const net = stubNetwork();
    const result = await execute(context({ model: "@cf/bytedance/stable-diffusion-xl-lightning" }));
    const upload = net.calls.find((call) => call.url.endsWith("/attachments") && call.method === "POST")!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect(postedBody(net.calls)).toBe("![How many apples are left?](/api/attachments/att-1/content)");
    expect(result.resultJson).toMatchObject({ freeUsage: { images: 1, equivalentUsd: 0.002 } });
  });

  it("runs Moan on Nemotron 3 Ultra with the Jamaican persona and the knowledge the server has", async () => {
    const net = stubNetwork({ commentReply: "Wah gwaan! Di answer a 29 apple." });
    const base = (globalThis.fetch as unknown as { getMockImplementation: () => (input: string, init?: RequestInit) => Promise<Response> }).getMockImplementation();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      if (String(input).startsWith(`${API}/api/free-models/moan/context?q=`)) {
        return new Response(JSON.stringify({ context: "- [Gleaner] Apples cheaper this week https://jamaica-gleaner.com/apples", freshness: "12 pages from 3 sources" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return base(input, init);
    }));
    const ctx = context({ model: "moan/moan-1:free", freeFiles: false, freeTeammates: false, freeWeb: false, freeConnections: false });
    const result = await execute(ctx);

    const sent = net.puterBodies()[0]!.args as { model: string; messages: Array<{ role: string; content: string }> };
    expect(sent.model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(sent.messages[0]!.role).toBe("system");
    expect(sent.messages[0]!.content).toContain("You are Atlas (Moan)");
    expect(sent.messages[0]!.content).toContain("Jamaican Patois is your default");
    expect(sent.messages[0]!.content).toContain("https://jamaica-gleaner.com/apples");
    expect(sent.messages[0]!.content).toContain("(12 pages from 3 sources)");
    expect(sent.messages[0]!.content).toContain("# Jamaica: the primer Moan carries");
    // The agent prompt follows the persona, so tools and manners still apply.
    expect(sent.messages[0]!.content).toContain("an AI agent on the person's team in Automa");
    expect(postedBody(net.calls)).toBe("Wah gwaan! Di answer a 29 apple.");
    // Shown as Moan; priced as the model it ran on.
    expect(result.model).toBe("moan/moan-1:free");
    expect(ctx.logs.some((line) => line.includes("Replied with moan/moan-1:free"))).toBe(true);
  });

  it("answers as Moan without the knowledge index, when the server has none", async () => {
    const net = stubNetwork({ commentReply: "Mi deh yah." });
    const ctx = context({ model: "moan/moan-1:free", freeFiles: false, freeTeammates: false, freeWeb: false, freeConnections: false });
    await execute(ctx);
    const sent = net.puterBodies()[0]!.args as { model: string; messages: Array<{ role: string; content: string }> };
    expect(sent.model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(sent.messages[0]!.content).not.toContain("Retrieved from Jamaican sources");
    expect(ctx.logs.some((line) => line.includes("Moan knowledge skipped"))).toBe(true);
    expect(postedBody(net.calls)).toBe("Mi deh yah.");
  });

  it("runs a native tool call whatever stop reason comes with it", async () => {
    const call = (id: string) => ({ type: "tool_use", id, name: "Automa", input: { method: "GET", path: `/api/agents/me?n=${id}` } });
    const net = stubThread({
      comments: [{ id: "c1", authorType: "user", authorAgentId: null, body: "Who am I talking to?" }],
      turns: [
        // A stream that ends without its usage line, then a provider that says "end_turn" beside a tool call.
        () => ndjson([call("t1")]),
        () => ndjson([call("t2"), { type: "usage", usageDetails: { inputTokens: 3, outputTokens: 1 }, stopReason: "end_turn" }]),
        () => ndjson([{ type: "text", text: "You are talking to Atlas." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 2 } }]),
      ],
    });
    await execute(context({ model: NEMOTRON, freeFiles: false, freeWeb: false, freeConnections: false, imageModel: "none" }));
    expect(net.sent()).toHaveLength(3);
    expect(net.sent()[2]!.messages.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(net.posted()).toBe("You are talking to Atlas.");
  });

  it("joins the empty-reply nudge to a message with a picture, never a second user turn", async () => {
    const empty = () => ndjson([{ type: "usage", usageDetails: { inputTokens: 5, outputTokens: 0 } }]);
    const net = stubThread({
      comments: [{ id: "c1", authorType: "user", authorAgentId: null, body: "What is in this photo?" }],
      attachments: [{ id: "img-1", issueCommentId: "c1", contentType: "image/jpeg", contentPath: "/api/attachments/img-1/content" }],
      turns: [empty, empty, () => ndjson([{ type: "text", text: "A fox in the snow." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 4 } }])],
    });
    await execute(context({ model: "nvidia/nemotron-3.5-super-vl:free", ...NO_TOOLS }));
    const last = net.sent()[2]!;
    expect(last.tools).toBeUndefined();
    expect(last.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const parts = last.messages[1]!.content as Array<{ type: string; text?: string }>;
    expect(parts.some((part) => part.type === "image_url")).toBe(true);
    expect(parts.some((part) => part.type === "text" && part.text!.includes("Your last reply came back empty"))).toBe(true);
    expect(net.posted()).toBe("A fox in the snow.");
  });

  it("reads a teammate agent's comment as said to this agent, not by it, and never sends two user turns in a row", async () => {
    const net = stubThread({
      comments: [
        { id: "c3", authorType: "agent", authorAgentId: "agent-2", body: "Atlas, please draft the Q3 summary." },
        { id: "c2", authorType: "user", authorAgentId: null, body: "Are you there?" },
        { id: "a1", authorType: "agent", authorAgentId: "agent-1", body: "Hi, I am Atlas." },
        { id: "c1", authorType: "user", authorAgentId: null, body: "Hello" },
      ],
      agents: [{ id: "agent-1", name: "Atlas" }, { id: "agent-2", name: "Nova", title: "CEO" }],
      turns: [() => ndjson([{ type: "text", text: "Drafting it now." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 3 } }])],
    });
    await execute(context({ model: NEMOTRON, ...NO_TOOLS }));
    const messages = net.sent()[0]!.messages;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(String(messages[2]!.content)).toBe("Hi, I am Atlas.");
    expect(String(messages[3]!.content)).toBe("Are you there?\n\n(From Nova, a teammate agent)\n\nAtlas, please draft the Q3 summary.");
    expect(net.posted()).toBe("Drafting it now.");
  });

  it("tells a model that can't see pictures that the person attached one", async () => {
    const net = stubThread({
      comments: [{ id: "c1", authorType: "user", authorAgentId: null, body: "What is in this photo?" }],
      attachments: [{ id: "img-1", issueCommentId: "c1", contentType: "image/jpeg", contentPath: "/api/attachments/img-1/content" }],
      turns: [() => ndjson([{ type: "text", text: "I can't see pictures." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 4 } }])],
    });
    await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", ...NO_TOOLS }));
    const system = String(net.sent()[0]!.messages[0]!.content);
    expect(system).toContain("attached a picture");
    expect(system).toContain("Nemotron 3.5 Super VL");
    // A model that can't read the photo never downloads it.
    expect(net.calls.some((c) => c.url.endsWith("/img-1/content"))).toBe(false);
  });

  it("never posts a tool call written as text once the tools are off", async () => {
    const net = stubThread({
      comments: [{ id: "c1", authorType: "user", authorAgentId: null, body: "Search for the news" }],
      turns: [
        refusal(400, { success: false, error: "Model does not support tools" }),
        () => ndjson([{ type: "text", text: '<tool_call>{"name": "ReadDocument", "arguments": {"attachment": "news.pdf"}}</tool_call>' }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 9 } }]),
        () => ndjson([{ type: "text", text: "I can't look that up from here." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 6 } }]),
      ],
    });
    await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", ...NO_TOOLS }));
    expect(net.sent()).toHaveLength(3);
    expect(net.posted()).toBe("I can't look that up from here.");
  });

  it("keeps a reply the model left inside an unclosed thinking tag instead of posting nothing", async () => {
    const net = stubThread({
      comments: [{ id: "c1", authorType: "user", authorAgentId: null, body: "How many apples are left?" }],
      turns: [() => ndjson([{ type: "text", text: "<thinking>3 x 12 = 36; 36 - 7 = 29. " }, { type: "text", text: "There are 29 apples left." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 9 } }])],
    });
    await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", effort: "high", ...NO_TOOLS }));
    expect(net.sent()).toHaveLength(1);
    expect(net.posted()).toContain("There are 29 apples left.");
  });

  it("asks Moan's knowledge index even when a long question is cut inside an emoji", async () => {
    const net = stubThread({
      comments: [{ id: "c1", authorType: "user", authorAgentId: null, body: `${"a".repeat(599)}🇯🇲 wah gwaan` }],
      turns: [() => ndjson([{ type: "text", text: "Mi deh yah." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 3 } }])],
    });
    await execute(context({ model: "moan/moan-1:free", ...NO_TOOLS }));
    expect(net.calls.some((c) => c.url.startsWith(`${API}/api/free-models/moan/context?q=`))).toBe(true);
  });

  const answer = (text: string) => () => ndjson([{ type: "text", text }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 2 } }]);
  const whoAmI = () => ndjson([{ type: "tool_use", id: `t${Math.random()}`, name: "Automa", input: { method: "GET", path: "/api/agents/me" } }, { type: "usage", usageDetails: { inputTokens: 3, outputTokens: 1 }, stopReason: "tool_use" }]);
  const hi = [{ id: "c1", authorType: "user", authorAgentId: null, body: "Who am I talking to?" }];
  const WITH_AUTOMA = { freeFiles: false, freeWeb: false, freeConnections: false, imageModel: "none" };

  it("retries a dropped connection like a busy provider, with the tools and history as they were", async () => {
    const reset = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }); };
    // A stream that delivers a piece and then loses its socket.
    const cutOff = () => {
      let started = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (started) return controller.error(new TypeError("terminated", { cause: new Error("other side closed") }));
          started = true;
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "text", text: "You are" })}\n`));
        },
      }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
    };
    const net = stubThread({ comments: hi, turns: [whoAmI, reset, cutOff, answer("You are talking to Atlas.")] });
    await execute(context({ model: NEMOTRON, ...WITH_AUTOMA }));
    const sent = net.sent();
    expect(sent).toHaveLength(4);
    for (const args of sent.slice(1)) {
      expect(args.tools?.length).toBeGreaterThan(0);
      expect(args.messages.some((m) => m.role === "tool")).toBe(true);
    }
    expect(net.posted()).toBe("You are talking to Atlas.");
  });

  it("ends with a readable error when the connection keeps dropping", async () => {
    const net = stubThread({
      comments: hi,
      turns: [() => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.puter.com"), { code: "EAI_AGAIN" }) }); }],
    });
    const outcome = await execute(context({ model: NEMOTRON, ...NO_TOOLS })).then(() => "", (e: Error) => e.message);
    // The first try, four retries, then the one try without streaming.
    expect(net.sent()).toHaveLength(6);
    expect(outcome).toContain("Nemotron 3 Ultra 550B");
    expect(outcome).toMatch(/connection/i);
    expect(outcome).not.toContain("fetch failed");
  });

  it("stops at once when the run is cancelled while it waits to retry", async () => {
    const controller = new AbortController();
    const net = stubThread({ comments: hi, turns: [() => { throw new TypeError("terminated"); }] });
    const ctx = { ...context({ model: NEMOTRON, ...NO_TOOLS }), signal: controller.signal };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let outcome: string | undefined;
      void execute(ctx).then(() => { outcome = "done"; }, (e: Error) => { outcome = e.name; });
      const tick = () => new Promise((resolve) => setImmediate(resolve));
      const waiting = () => ctx.logs.some((line) => line.includes("retrying in a moment"));
      for (let i = 0; i < 500 && !waiting() && outcome === undefined; i += 1) await tick();
      expect(waiting()).toBe(true);
      controller.abort();
      // The clock never moves: a wait that ignored the cancel would never end.
      for (let i = 0; i < 500 && outcome === undefined; i += 1) await tick();
      expect(outcome).toBe("AbortError");
      expect(net.sent()).toHaveLength(1);
      expect(net.calls.some((c) => c.method === "POST" && c.url.endsWith("/comments"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the tools and their history through server errors, which are a wait", async () => {
    const net = stubThread({
      comments: hi,
      turns: [refusal(500, { error: "Internal server error" }), whoAmI, refusal(502, { error: "Bad gateway" }), answer("You are talking to Atlas.")],
    });
    await execute(context({ model: NEMOTRON, ...WITH_AUTOMA }));
    const sent = net.sent();
    expect(sent).toHaveLength(4);
    expect(sent.every((args) => (args.tools?.length ?? 0) > 0)).toBe(true);
    expect(sent[3]!.messages.some((m) => m.role === "tool")).toBe(true);
    expect(net.posted()).toBe("You are talking to Atlas.");
  });

  it("keeps a made document out of the working folder when Files & commands is off, and still attaches it", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "automa-free-docs-"));
    const makeDoc = () => ndjson([{ type: "tool_use", id: `t${Math.random()}`, name: "CreateDocument", input: { title: "Plan", markdown: "# Plan\n\nShip it on Friday." } }, { type: "usage", usageDetails: { inputTokens: 3, outputTokens: 1 }, stopReason: "tool_use" }]);
    const config = { model: NEMOTRON, cwd, freeTeammates: true, freeWeb: false, freeConnections: false, imageModel: "none" };
    try {
      const off = stubThread({ comments: hi, turns: [makeDoc, answer("Here is the plan.")] });
      await execute(context({ ...config, freeFiles: false }));
      expect(off.calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/issue-1/attachments"))).toBe(true);
      expect(off.posted()).toContain("Plan.docx");
      await expect(fs.readdir(path.join(cwd, "documents"))).rejects.toThrow();
      // With files on, the same document is kept in the folder as well.
      stubThread({ comments: hi, turns: [makeDoc, answer("Here is the plan.")] });
      await execute(context({ ...config, freeFiles: true }));
      expect(await fs.readdir(path.join(cwd, "documents"))).toEqual(["Plan.docx"]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("offers no GenerateImage when the paired image model is only an object property name", async () => {
    const net = stubThread({ comments: hi, turns: [answer("Hello.")] });
    await execute(context({ model: NEMOTRON, ...NO_TOOLS, imageModel: "toString" }));
    expect(((net.sent()[0]!.tools ?? []) as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual(OFFICE_TOOL_NAMES);
  });

  it("explains a missing agent key instead of answering silently", async () => {
    stubNetwork();
    await expect(execute(context({}, null))).rejects.toThrow(/PAPERCLIP_AGENT_JWT_SECRET/);
  });
});
