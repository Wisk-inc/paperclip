import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../types.js";

vi.mock("../../services/free-models.js", () => ({
  equivalentTokenCostUsd: vi.fn(async () => 0.001),
  equivalentImageCostUsd: (images: number) => images * 0.002,
}));

const { execute } = await import("./execute.js");

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

beforeEach(() => { process.env.PAPERCLIP_API_URL = API; });
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

  it("keeps the chosen model and retries it when the provider is busy", async () => {
    const net = stubPuter([
      refusal(429, { error: "AI provider rate limit exceeded", code: "upstream_rate_limited" }),
      () => ndjson([{ type: "text", text: "Back now." }, { type: "usage", usageDetails: { inputTokens: 5, outputTokens: 2 } }]),
    ]);
    await execute(context({ model: NEMOTRON, ...NO_TOOLS }));
    expect(net.puterModels()).toEqual([NEMOTRON, NEMOTRON]);
    expect(net.posted()).toBe("Back now.");
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
    expect(first.tools?.map((tool) => tool.function.name)).toEqual(["GenerateImage"]);
    expect(first.messages[0]!.content).toContain("call GenerateImage");
    expect(net.calls.some((call) => call.url.endsWith("/attachments") && call.method === "POST")).toBe(true);
    expect(postedBody(net.calls)).toContain("![a red fox in snow at night, cinematic](/api/attachments/att-1/content)");
    expect(result.resultJson).toMatchObject({ freeUsage: { images: 1 } });
  });

  it("offers no GenerateImage when the pairing is switched off", async () => {
    const net = stubNetwork();
    await execute(context({ model: "deepseek/deepseek-v4.1-flash:free", imageModel: "none", freeFiles: false, freeWeb: false, freeConnections: false, freeTeammates: false }));
    const first = net.puterBodies()[0]!.args as { tools?: unknown[] };
    expect(first.tools ?? []).toEqual([]);
  });

  it("draws with an image model, uploads the picture, and embeds it", async () => {
    const net = stubNetwork();
    const result = await execute(context({ model: "@cf/bytedance/stable-diffusion-xl-lightning" }));
    const upload = net.calls.find((call) => call.url.endsWith("/attachments") && call.method === "POST")!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect(postedBody(net.calls)).toBe("![How many apples are left?](/api/attachments/att-1/content)");
    expect(result.resultJson).toMatchObject({ freeUsage: { images: 1, equivalentUsd: 0.002 } });
  });

  it("explains a missing agent key instead of answering silently", async () => {
    stubNetwork();
    await expect(execute(context({}, null))).rejects.toThrow(/PAPERCLIP_AGENT_JWT_SECRET/);
  });
});
