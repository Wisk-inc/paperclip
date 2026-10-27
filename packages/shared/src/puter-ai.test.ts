import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describePuterError,
  formatSafetyVerdict,
  freeModelHealth,
  mayHoldTextToolCalls,
  parseTextToolCalls,
  PUTER_MODELS,
  puterModelTakesTools,
  PuterHttpError,
  puterStream,
  resetFreeModelHealth,
  type PuterStreamEvent,
  type PuterTool,
} from "./puter-ai.js";

const DAILY_LIMIT = JSON.stringify({
  error: "AI provider rate limit exceeded",
  code: "upstream_rate_limited",
  attempts: [{ status: 429, error: "429 Free model daily limit exceeded (1000 requests per day). Please try again after 5368 seconds." }],
});
const RESTRICTED = JSON.stringify({
  error: "AI provider authentication failed",
  code: "upstream_auth_failed",
  attempts: [{ status: 403, error: "403 thinkingmachines/inkling:free is only available on agentic harnesses." }],
});
const BUSY = JSON.stringify({ error: "AI provider rate limit exceeded", code: "upstream_rate_limited", attempts: [{ status: 429, error: "429 Provider returned error" }] });
const WEATHER: PuterTool = { type: "function", function: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } } };

/** A streamed reply as the service sends it: text lines, then the usage line. */
function stream(text: string, cents = 0) {
  const lines = [JSON.stringify({ type: "text", text }), JSON.stringify({ type: "usage", usage: { prompt: 5, completion: 7, usd_cents: cents }, usageDetails: { inputTokens: 5, outputTokens: 7 }, stopReason: "end_turn" })];
  return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
const refusal = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } });

let calls: Array<{ model: string; tools: unknown; messages: Array<{ role: string; content: unknown }> }> = [];
function serve(...replies: Response[]) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { args: { model: string; tools?: unknown; messages: Array<{ role: string; content: unknown }> } };
    calls.push({ model: body.args.model, tools: body.args.tools, messages: body.args.messages });
    const next = replies.shift();
    if (!next) throw new Error("no reply scripted");
    return next;
  }));
}
async function collect(model: string, tools?: PuterTool[]) {
  const events: PuterStreamEvent[] = [];
  for await (const event of puterStream([{ role: "user", content: "hi" }], { model, tools })) events.push(event);
  return events;
}

beforeEach(() => resetFreeModelHealth());
afterEach(() => vi.unstubAllGlobals());

describe("free model refusals", () => {
  it("tells a daily limit, a closed model, a withdrawn one, a busy one and a tool refusal apart", () => {
    const daily = new PuterHttpError(429, DAILY_LIMIT);
    expect(daily.kind).toBe("daily_limit");
    expect(daily.retryAfterMs).toBe(5368_000);
    expect(new PuterHttpError(500, RESTRICTED).kind).toBe("restricted");
    expect(new PuterHttpError(400, JSON.stringify({ error: "Model not found: nvidia/nemotron-3-super-120b-a12b:free", code: "bad_request" })).kind).toBe("withdrawn");
    expect(new PuterHttpError(429, BUSY).kind).toBe("busy");
    expect(new PuterHttpError(400, JSON.stringify({ error: "404 No endpoints found that support tool use." })).kind).toBe("no_tools");
  });

  it("says when a model at its daily limit is back, and that it isn't the person's doing", () => {
    const message = describePuterError(new PuterHttpError(429, DAILY_LIMIT), "DeepSeek V4.1 Flash").message;
    expect(message).toContain("DeepSeek V4.1 Flash has used up today's free requests");
    expect(message).toContain("isn't anything you did");
    expect(message).toContain("back in about 1 hour 30 minutes");
    expect(describePuterError(new PuterHttpError(500, RESTRICTED), "Inkling").message).toContain("only lets certain partner apps use it");
  });
});

describe("puterStream", () => {
  it("only calls Automa's own free models", async () => {
    serve();
    await expect(collect("openai/gpt-6.1-terra")).rejects.toThrow("is not one of Automa's free models");
    expect(calls).toHaveLength(0);
  });

  it("calls a model by its service route when Automa's id differs", async () => {
    serve(stream("Hello"));
    await collect(PUTER_MODELS["bonsai-27b"]);
    expect(calls[0]!.model).toBe("togetherai:prism-ml/ternary-bonsai-27b");
  });

  it("holds a model at its daily limit until the reset instead of calling it again", async () => {
    serve(refusal(429, DAILY_LIMIT));
    await expect(collect(PUTER_MODELS["deepseek-flash"])).rejects.toMatchObject({ kind: "daily_limit" });
    await expect(collect(PUTER_MODELS["deepseek-flash"])).rejects.toMatchObject({ kind: "daily_limit" });
    expect(calls).toHaveLength(1);
    expect(freeModelHealth()[PUTER_MODELS["deepseek-flash"]]).toMatchObject({ state: "daily_limit" });
    expect(new Date(freeModelHealth()[PUTER_MODELS["deepseek-flash"]]!.until!).getTime()).toBeGreaterThan(Date.now() + 5000_000);
  });

  it("asks a busy Gemma again over Google's route, with its tools as text", async () => {
    serve(
      refusal(429, BUSY),
      stream('<thought>Use the tool.</thought>Checking.\n<tool_call>{"name": "get_weather", "arguments": {"city": "Kingston"}}</tool_call>'),
    );
    const events = await collect(PUTER_MODELS["gemma-31b"], [WEATHER]);
    expect(calls.map((call) => call.model)).toEqual([PUTER_MODELS["gemma-31b"], "gemma-4-31b-it"]);
    // Google's route gets no native tools; the system message explains how to call them as text.
    expect(calls[1]!.tools).toBeUndefined();
    expect(String(calls[1]!.messages[0]!.content)).toContain("<tool_call>");
    expect(events).toEqual([
      { type: "reasoning", text: "Use the tool." },
      { type: "text", text: "Checking." },
      expect.objectContaining({ type: "tool_use", name: "get_weather", input: { city: "Kingston" } }),
      { type: "done", usage: { inputTokens: 5, outputTokens: 7 }, stopReason: "tool_use" },
    ]);
  });

  it("asks the Free Router again when it hands the request to the safety classifier", async () => {
    serve(stream("User Safety: safe"), stream("Hello! How can I help today?"));
    const events = await collect(PUTER_MODELS["free-router"]);
    expect(calls).toHaveLength(2);
    expect(events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text).join("")).toBe("Hello! How can I help today?");
  });

  it("stops calling a model that starts charging the shared allowance", async () => {
    serve(stream("ok", 4));
    await collect(PUTER_MODELS["flint"]);
    await expect(collect(PUTER_MODELS["flint"])).rejects.toMatchObject({ kind: "charged" });
    expect(calls).toHaveLength(1);
  });
});

describe("tool calls written as text", () => {
  it("reads the Python-style call some routed models write before a closing tag", () => {
    const parsed = parseTextToolCalls('WebSearch(query="capital of Jamaica population", count=5) </tool_call>', ["WebSearch"]);
    expect(parsed.calls).toEqual([{ name: "WebSearch", input: { query: "capital of Jamaica population", count: 5 } }]);
    expect(parsed.text).toBe("");
  });

  it("reads a Python-style call inside the tags, and leaves code that only looks like one", () => {
    expect(parseTextToolCalls("<tool_call>WebFetch(url='https://jis.gov.jm', raw=False)</tool_call>", ["WebFetch"]).calls).toEqual([
      { name: "WebFetch", input: { url: "https://jis.gov.jm", raw: false } },
    ]);
    const code = "Call it like this:\n\nWebSearch(query=\"x\")";
    expect(parseTextToolCalls(code, ["WebSearch"])).toEqual({ text: code, calls: [] });
    expect(mayHoldTextToolCalls(code)).toBe(false);
    expect(mayHoldTextToolCalls("WebSearch(query=\"x\") </tool_call>")).toBe(true);
  });
});

describe("free model helpers", () => {
  it("knows Content Safety takes no tools", () => {
    expect(puterModelTakesTools(PUTER_MODELS["nemotron-safety"])).toBe(false);
    expect(puterModelTakesTools(PUTER_MODELS["nemotron-ultra"])).toBe(true);
  });

  it("turns a safety verdict into a readable answer", () => {
    expect(formatSafetyVerdict("User Safety: safe")).toBe("**Safety check: safe.** Nothing harmful found in the message.");
    expect(formatSafetyVerdict("User Safety: unsafe\nSafety Categories: Violence, Criminal Planning/Confessions")).toBe(
      "**Safety check: unsafe.** Flagged for: Violence, Criminal Planning/Confessions.",
    );
    expect(formatSafetyVerdict("Something else")).toBe("Something else");
  });

  it("reads tool calls written as text, and only for tools it was given", () => {
    const parsed = parseTextToolCalls(
      'Let me look.\n<tool_call>{"name": "get_weather", "arguments": {"city": "Ocho Rios"}}</tool_call>\n<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>\n[Called get_weather {"city": "Negril"}]',
      ["get_weather"],
    );
    expect(parsed.calls).toEqual([
      { name: "get_weather", input: { city: "Ocho Rios" } },
      { name: "get_weather", input: { city: "Negril" } },
    ]);
    expect(parsed.text).toBe('Let me look.\n\n<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>');
  });
});
