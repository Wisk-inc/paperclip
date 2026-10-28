import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describePuterError,
  formatSafetyVerdict,
  freeModelHealth,
  mayHoldTextToolCalls,
  parseTextToolCalls,
  PUTER_MODELS,
  puterClearConvo,
  puterComplete,
  puterConvo,
  puterImage,
  puterModelTakesTools,
  PuterHttpError,
  puterStream,
  resetFreeModelHealth,
  type PuterStreamEvent,
  type PuterTool,
} from "./puter-ai.js";

const queue = vi.hoisted(() => ({ refreshes: 0 }));
// The real queue, counting each time a turn's safety timer is restarted.
vi.mock("./que-queue.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./que-queue.js")>();
  return {
    ...real,
    queTurn: async (signal?: AbortSignal, model?: string) => {
      const release = await real.queTurn(signal, model);
      return Object.assign(() => release(), {
        refresh: () => {
          queue.refreshes += 1;
          (release as { refresh?: () => void }).refresh?.();
        },
      });
    },
  };
});

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
/** A one-shot (not streamed) reply. */
const chatReply = (content: string, cents = 0) =>
  new Response(JSON.stringify({ success: true, result: { message: { content }, usage: { prompt: 3, completion: 2, usd_cents: cents } } }), { status: 200, headers: { "content-type": "application/json" } });
/** A stream that sends `lines` and then stays open until it is cancelled. */
function openStream(lines: unknown[], onCancel: () => void) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
    },
    cancel: onCancel,
  }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

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

  it("never takes a model id from the object prototype", async () => {
    serve();
    await expect(collect("toString")).rejects.toThrow(`"toString" is not one of Automa's free models`);
    await expect(puterImage("A beach in Negril", { model: "constructor" as never })).rejects.toThrow("Unknown image model: constructor");
    expect(calls).toHaveLength(0);
  });

  it("ends the call upstream when the caller stops reading, or the stream sends an error", async () => {
    let cancelled = 0;
    serve(
      openStream([{ type: "text", text: "Hello" }], () => { cancelled += 1; }),
      openStream([{ type: "text", text: "Hi" }, { success: false, error: { message: "upstream closed" } }], () => { cancelled += 1; }),
    );
    for await (const event of puterStream([{ role: "user", content: "hi" }], { model: PUTER_MODELS["flint"] })) {
      expect(event).toEqual({ type: "text", text: "Hello" });
      break;
    }
    expect(cancelled).toBe(1);
    await expect(collect(PUTER_MODELS["flint"])).rejects.toBeInstanceOf(PuterHttpError);
    expect(cancelled).toBe(2);
  });

  it("keeps its queue turn while a long stream is still sending", async () => {
    queue.refreshes = 0;
    const encoder = new TextEncoder();
    const pieces = [{ type: "text", text: "Wah" }, { type: "text", text: " gwaan" }, { type: "usage", usageDetails: { inputTokens: 1, outputTokens: 2 } }];
    serve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(`${JSON.stringify(piece)}\n`));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/x-ndjson" } }));
    await collect(PUTER_MODELS["flint"]);
    expect(queue.refreshes).toBe(3);
  });

  it("counts one-shot and streamed calls to one model against the same limit", async () => {
    const answers: Array<(reply: Response) => void> = [];
    const fetchMock = vi.fn((_url: string, _init: { body: string }) => new Promise<Response>((resolve) => answers.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const bonsai = PUTER_MODELS["bonsai-27b"];
    const streams = [collect(bonsai), collect(bonsai)];
    const oneShot = puterComplete([{ role: "user", content: "hi" }], { model: bonsai, retries: 1 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Two calls to one model at a time, whatever the route: the one-shot waits for a stream to end.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    answers[0]!(stream("One"));
    await streams[0];
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    answers[1]!(stream("Two"));
    answers[2]!(chatReply("Three"));
    await expect(oneShot).resolves.toMatchObject({ text: "Three" });
    await streams[1];
  });

  it("blanks the free-model token out of a refusal that echoes the request", async () => {
    let token = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      token = (JSON.parse(init.body) as { auth_token: string }).auth_token;
      return refusal(400, JSON.stringify({ error: `Invalid auth_token ${token}` }));
    }));
    const error = await collect(PUTER_MODELS["flint"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PuterHttpError);
    const { message, body, upstream } = error as PuterHttpError;
    expect(token.length).toBeGreaterThan(100);
    for (const text of [message, body, upstream ?? ""]) expect(text.includes(token.slice(30, 70))).toBe(false);
    expect(body).toContain("Invalid auth_token [hidden]");
  });
});

describe("one-shot calls", () => {
  it("stops calling a model whose one-shot reply charged the shared allowance", async () => {
    serve(chatReply("ok", 4), chatReply("", 4), chatReply("ok"));
    const ask = (model: string) => puterComplete([{ role: "user", content: "hi" }], { model, retries: 2 });
    await expect(ask(PUTER_MODELS["flint"])).resolves.toMatchObject({ text: "ok" });
    await expect(ask(PUTER_MODELS["flint"])).rejects.toMatchObject({ kind: "charged" });
    // A charged reply with no words is not asked again either.
    await expect(ask(PUTER_MODELS["xing4"])).rejects.toMatchObject({ kind: "charged" });
    expect(calls.map((call) => call.model)).toEqual([PUTER_MODELS["flint"], PUTER_MODELS["xing4"]]);
  });

  it("keeps a conversation on a routed model, and leaves out a turn that failed", async () => {
    serve(refusal(400, JSON.stringify({ error: "Bad request" })), chatReply("Hi!"));
    await expect(puterConvo("hello", "routed", { model: "bonsai-27b", retries: 1 })).rejects.toBeInstanceOf(PuterHttpError);
    await expect(puterConvo("hello again", "routed", { model: "bonsai-27b", retries: 1 })).resolves.toBe("Hi!");
    expect(calls.map((call) => call.model)).toEqual(["togetherai:prism-ml/ternary-bonsai-27b", "togetherai:prism-ml/ternary-bonsai-27b"]);
    expect(calls[1]!.messages).toEqual([{ role: "user", content: "hello again" }]);
    puterClearConvo("routed");
  });
});

describe("deadlines", () => {
  afterEach(() => vi.useRealTimers());

  it("gives up on a stream that goes quiet, even when the caller passes a signal", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    serve(openStream([{ type: "text", text: "Hel" }], () => { cancelled = true; }));
    const events: PuterStreamEvent[] = [];
    const run = (async () => {
      for await (const event of puterStream([{ role: "user", content: "hi" }], { model: PUTER_MODELS["flint"], signal: new AbortController().signal })) events.push(event);
    })();
    const outcome = expect(run).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await outcome;
    expect(events).toEqual([{ type: "text", text: "Hel" }]);
    expect(cancelled).toBe(true);
  });

  it("gives up on a one-shot call that never answers, even when the caller passes a signal", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })));
    const outcome = expect(puterComplete([{ role: "user", content: "hi" }], { model: PUTER_MODELS["flint"], retries: 1, signal: new AbortController().signal }))
      .rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await outcome;
  });
});

describe("tool calls written as text", () => {
  it("reads the Python-style call some routed models write before a closing tag", () => {
    const parsed = parseTextToolCalls('WebSearch(query="capital of Jamaica population", count=5) </tool_call>', ["WebSearch"]);
    expect(parsed.calls).toEqual([{ name: "WebSearch", input: { query: "capital of Jamaica population", count: 5 } }]);
    expect(parsed.text).toBe("");
  });

  it("reads the escapes in a Python-style call's strings the way Python does", () => {
    const parsed = parseTextToolCalls(
      String.raw`<tool_call>write_file(path='notes.txt', content='Line one\nLine two\t"quoted" it\'s', pattern="\\d+ \d")</tool_call>`,
      ["write_file"],
    );
    expect(parsed.calls).toEqual([{ name: "write_file", input: { path: "notes.txt", content: "Line one\nLine two\t\"quoted\" it's", pattern: String.raw`\d+ \d` } }]);
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
