import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freeModelAnswering } from "./free-models.js";
import {
  APP_ID_POOL_MAX,
  appIdPoolStats,
  describePuterError,
  formatSafetyVerdict,
  freeModelAllowance,
  freeModelHealth,
  freeServiceSlowDownMs,
  isLastingPuterError,
  isTransientPuterError,
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
  resetFreeModelAllowance,
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
/** A provider's rate-limit refusal as the service passes it on. */
const rateLimited = (upstream: string) => JSON.stringify({ error: "AI provider rate limit exceeded", code: "upstream_rate_limited", attempts: [{ status: 429, error: upstream }] });
/** The daily cap as the provider words it today: no "daily limit", no "requests per day". */
const PER_DAY = rateLimited("429 Rate limit exceeded: free-models-per-day-high-balance. ");
const PER_MINUTE = rateLimited("429 Rate limit exceeded: free-models-per-min. ");
const WEATHER: PuterTool = { type: "function", function: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } } };

/** A streamed reply as the service sends it: text lines, then the usage line. */
function stream(text: string, cents = 0) {
  const lines = [JSON.stringify({ type: "text", text }), JSON.stringify({ type: "usage", usage: { prompt: 5, completion: 7, usd_cents: cents }, usageDetails: { inputTokens: 5, outputTokens: 7 }, stopReason: "end_turn" })];
  return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
const refusal = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } });
/** A 200 stream of the given lines, as they are. */
const lines = (...sent: unknown[]) => new Response(`${sent.map((line) => JSON.stringify(line)).join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
/** A 200 reply that is JSON, not a stream. */
const json200 = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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

  it("tells the person to pick another model when the chosen one is closed, offline or paused for charging", () => {
    const closed = [
      describePuterError(new PuterHttpError(500, RESTRICTED), "Inkling").message,
      describePuterError(new PuterHttpError(400, JSON.stringify({ error: "Model not found: nvidia/nemotron-3-super-120b-a12b:free" })), "Nemotron 3 Super 120B").message,
      describePuterError(new PuterHttpError(402, JSON.stringify({ error: "flint charged the shared allowance (4 cents)" })), "Flint v1.0").message,
    ];
    for (const message of closed) {
      expect(message.endsWith("To keep going now, pick another model in the model menu.")).toBe(true);
      expect(message).not.toContain("—");
    }
    expect(closed[0]).toContain("only lets certain partner apps use it");
    expect(closed[1]).toContain("taken offline by its provider");
    expect(closed[2]).toContain("started charging");
  });
});

describe("a refusal's own words in a sentence", () => {
  it("ends the sentence once when the service's words already end with a period", () => {
    const message = describePuterError(new PuterHttpError(401, JSON.stringify({ code: "token_auth_failed", message: "Authentication failed." })), "Flint v1.0").message;
    expect(message).toContain("Flint v1.0 rejected the request: Authentication failed. Send the message again");
    expect(message).not.toContain("..");
  });
});

describe("a model's daily limit, however its provider words it", () => {
  const NOW = Date.parse("2026-11-22T15:00:00.000Z");
  const TO_MIDNIGHT = 9 * 60 * 60_000;
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW); });
  afterEach(() => vi.restoreAllMocks());

  it("reads the per-day rate limit as a daily limit, back at midnight UTC", () => {
    const shapes = [
      PER_DAY,
      "Rate limit exceeded: free-models-per-day-high-balance",
      rateLimited("429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"),
      rateLimited("429 Daily quota exceeded for this model. Quota resets at midnight UTC."),
      rateLimited("429 You have reached the daily request limit for free models."),
      rateLimited("429 You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50, per day"),
    ];
    for (const body of shapes) {
      const error = new PuterHttpError(429, body);
      expect(error.kind, body).toBe("daily_limit");
      expect(error.retryAfterMs, body).toBe(TO_MIDNIGHT);
      expect(isLastingPuterError(error)).toBe(true);
      expect(isTransientPuterError(error)).toBe(false);
      expect(error.slowDown).toBe(false);
    }
  });

  it("leaves the per-minute rate limit a busy model, asked again", () => {
    const error = new PuterHttpError(429, PER_MINUTE);
    expect(error.kind).toBe("busy");
    expect(error.retryAfterMs).toBeNull();
    expect(isTransientPuterError(error)).toBe(true);
  });

  it("waits the time the provider names, in the unit it names", () => {
    const wait = (said: string) => new PuterHttpError(429, rateLimited(`429 Free model daily limit exceeded. ${said}`)).retryAfterMs;
    expect(wait("Please try again in 2 hours.")).toBe(7_200_000);
    expect(wait("Please try again in 45 minutes.")).toBe(2_700_000);
    expect(wait("Please try again after 5368 seconds.")).toBe(5_368_000);
    expect(wait("Please try again in an hour.")).toBe(3_600_000);
    // Never under a minute, never over a day.
    expect(wait("Please try again in 2 seconds.")).toBe(60_000);
    expect(wait("Please try again in 90 hours.")).toBe(24 * 60 * 60_000);
    // No time named: the reset at midnight UTC.
    expect(wait("")).toBe(TO_MIDNIGHT);
  });

  it("takes the reset from the provider's own rate-limit header when the refusal carries it", () => {
    const nested = (reset: string) => JSON.stringify({ error: {
      message: "Rate limit exceeded: free-models-per-day-high-balance. ",
      code: 429,
      metadata: { headers: { "X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset } },
    } });
    const inMs = new PuterHttpError(429, nested(String(NOW + 3 * 60 * 60_000)));
    expect(inMs).toMatchObject({ kind: "daily_limit", retryAfterMs: 3 * 60 * 60_000 });
    // The provider's own words are read out of the nested error, for the message a person sees.
    expect(inMs.upstream).toBe("Rate limit exceeded: free-models-per-day-high-balance.");
    expect(new PuterHttpError(429, nested(String((NOW + 5 * 60 * 60_000) / 1000))).retryAfterMs).toBe(5 * 60 * 60_000);
    // A reset already past says nothing: midnight UTC.
    expect(new PuterHttpError(429, nested(String(NOW - 1000))).retryAfterMs).toBe(TO_MIDNIGHT);
  });
});

describe("a model at the per-day rate limit", () => {
  it("is held after the first refusal: the next ask sends no request, and health says daily limit", async () => {
    serve(refusal(429, PER_DAY));
    const model = PUTER_MODELS["nemotron-ultra"];
    await expect(collect(model)).rejects.toMatchObject({ kind: "daily_limit" });
    await expect(collect(model)).rejects.toMatchObject({ kind: "daily_limit" });
    await expect(puterComplete([{ role: "user", content: "hi" }], { model })).rejects.toMatchObject({ kind: "daily_limit" });
    expect(calls).toHaveLength(1);
    const health = freeModelHealth()[model]!;
    expect(health).toMatchObject({ state: "daily_limit", last: "daily_limit" });
    // Held until the reset at midnight UTC, not for a busy model's minute and a half.
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0);
    expect(Math.abs(new Date(health.until!).getTime() - next.getTime())).toBeLessThan(5000);
    expect(freeModelAnswering(health)).toBe(false);
  });

  it("holds a model for the hours its provider named, not for that many seconds", async () => {
    serve(refusal(429, rateLimited("429 Free model daily limit exceeded. Please try again in 2 hours.")));
    const model = PUTER_MODELS["deepseek-flash"];
    await expect(collect(model)).rejects.toMatchObject({ kind: "daily_limit" });
    const health = freeModelHealth()[model]!;
    const held = new Date(health.until!).getTime() - new Date(health.checkedAt).getTime();
    expect(held).toBe(7_200_000);
  });
});

describe("a model with a second route", () => {
  const GEMMA = PUTER_MODELS["gemma-31b"];
  const BACKUP = "gemma-4-31b-it";
  const models = () => calls.map((call) => call.model);
  const text = (events: PuterStreamEvent[]) => events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text).join("");

  it("answers over the second route when the main one is at its daily limit, and goes straight there next time", async () => {
    serve(refusal(429, PER_DAY), stream("From the second route"), stream("Again from the second route"));
    expect(text(await collect(GEMMA))).toBe("From the second route");
    expect(models()).toEqual([GEMMA, BACKUP]);
    expect(text(await collect(GEMMA))).toBe("Again from the second route");
    expect(models()).toEqual([GEMMA, BACKUP, BACKUP]);
    // The model answers, so health says so: it is the main route that is out, not the model.
    expect(freeModelHealth()[GEMMA]).toMatchObject({ state: "ok", last: "ok" });
  });

  it("does the same for a one-shot call", async () => {
    serve(refusal(429, PER_DAY), chatReply("From the second route"), chatReply("Again"));
    const ask = () => puterComplete([{ role: "user", content: "hi" }], { model: GEMMA, retries: 1 });
    await expect(ask()).resolves.toMatchObject({ text: "From the second route", model: GEMMA });
    await expect(ask()).resolves.toMatchObject({ text: "Again" });
    expect(models()).toEqual([GEMMA, BACKUP, BACKUP]);
    expect(freeModelHealth()[GEMMA]).toMatchObject({ state: "ok", last: "ok" });
  });

  it("takes the second route when the main one is closed to Automa or taken offline", async () => {
    serve(refusal(403, RESTRICTED), stream("Hello"));
    expect(text(await collect(GEMMA))).toBe("Hello");
    expect(models()).toEqual([GEMMA, BACKUP]);
    resetFreeModelHealth();
    serve(refusal(400, JSON.stringify({ error: "Model not found: google/gemma-4-31b-it:free" })), stream("Hello"));
    expect(text(await collect(GEMMA))).toBe("Hello");
    expect(models()).toEqual([GEMMA, BACKUP]);
  });

  it("is refused without a request once both routes are out for the day, then asks the second route again after a short hold", async () => {
    vi.useFakeTimers();
    // Well before midnight UTC, when the main route's own hold would end.
    vi.setSystemTime(new Date("2026-11-22T15:00:00.000Z"));
    try {
      serve(refusal(429, PER_DAY), refusal(429, PER_DAY), stream("Back"));
      await expect(collect(GEMMA)).rejects.toMatchObject({ kind: "daily_limit" });
      expect(models()).toEqual([GEMMA, BACKUP]);
      expect(freeModelHealth()[GEMMA]).toMatchObject({ state: "daily_limit" });
      await expect(collect(GEMMA)).rejects.toMatchObject({ kind: "daily_limit" });
      expect(calls).toHaveLength(2);
      // The second route's limits are its own provider's: it is asked again soon, the main route not before its reset.
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
      expect(text(await collect(GEMMA))).toBe("Back");
      expect(models()).toEqual([GEMMA, BACKUP, BACKUP]);
      expect(freeModelHealth()[GEMMA]).toMatchObject({ state: "ok", last: "ok" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the model is busy, not out for the day, when its second route is only busy", async () => {
    serve(refusal(429, PER_DAY), refusal(429, BUSY), stream("Back"));
    const refused = await collect(GEMMA).catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: "busy" });
    expect(isTransientPuterError(refused)).toBe(true);
    expect(freeModelHealth()[GEMMA]).toMatchObject({ state: "busy" });
    // A busy route is still asked, as a busy model is; the main route stays out.
    expect(text(await collect(GEMMA))).toBe("Back");
    expect(models()).toEqual([GEMMA, BACKUP, BACKUP]);
  });

  it("counts a second route's tries against the same retries, so a busy model is not asked more than before", async () => {
    vi.useFakeTimers();
    try {
      serve(...Array.from({ length: 8 }, () => refusal(429, BUSY)));
      const outcome = puterComplete([{ role: "user", content: "hi" }], { model: GEMMA, retries: 3 }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await outcome).toMatchObject({ kind: "busy" });
      // The move to the second route, then two more tries: four calls, as when only a busy main route moved over.
      expect(models()).toEqual([GEMMA, BACKUP, BACKUP, GEMMA]);
      expect(freeModelHealth()[GEMMA]).toMatchObject({ state: "busy" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still stops calling the model on any route once it charges the shared allowance", async () => {
    serve(refusal(429, BUSY), stream("ok", 4));
    await collect(GEMMA);
    await expect(collect(GEMMA)).rejects.toMatchObject({ kind: "charged" });
    expect(calls).toHaveLength(2);
  });
});

describe("a refusal sent inside a 200 reply", () => {
  const ULTRA = PUTER_MODELS["nemotron-ultra"];

  it("remembers a daily limit that arrives as a line of the stream", async () => {
    serve(lines({ success: false, error: { message: "429 Free model daily limit exceeded (1000 requests per day). Please try again after 5368 seconds." } }));
    await expect(collect(ULTRA)).rejects.toMatchObject({ kind: "daily_limit", retryAfterMs: 5_368_000 });
    expect(freeModelHealth()[ULTRA]).toMatchObject({ state: "daily_limit" });
    await expect(collect(ULTRA)).rejects.toMatchObject({ kind: "daily_limit" });
    expect(calls).toHaveLength(1);
  });

  it("reads an error line of a kind it does not know as the refusal it is, never as an empty answer", async () => {
    serve(lines({ type: "error", message: "Rate limit exceeded: free-models-per-day-high-balance" }));
    const error = await collect(ULTRA).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PuterHttpError);
    expect(error).toMatchObject({ kind: "daily_limit", upstream: "Rate limit exceeded: free-models-per-day-high-balance" });
    expect(freeModelHealth()[ULTRA]).toMatchObject({ state: "daily_limit" });
  });

  it("keeps the status and code a stream's error line names", async () => {
    serve(lines({ success: false, error: { message: "AI provider rate limit exceeded", code: "upstream_rate_limited", status: 429 } }));
    await expect(collect(ULTRA)).rejects.toMatchObject({ status: 429, kind: "busy", code: "upstream_rate_limited" });
    expect(freeModelHealth()[ULTRA]).toMatchObject({ state: "busy" });
    serve(lines({ success: false, error: { message: "Rate limit exceeded: free-models-per-min. ", code: 429 } }));
    await expect(collect(ULTRA)).rejects.toMatchObject({ status: 429, kind: "busy" });
  });

  it("reads a rate limit sent as 200 JSON as a rate limit, not as a rejected request", async () => {
    serve(json200({ success: false, error: { code: "upstream_rate_limited", message: "AI provider rate limit exceeded", status: 429 } }));
    const error = await collect(ULTRA).catch((caught: unknown) => caught) as PuterHttpError;
    // 429, so the engines wait and ask again with the request as it was; a 400 made them strip the tool history.
    expect(error).toMatchObject({ status: 429, kind: "busy", code: "upstream_rate_limited", upstream: "AI provider rate limit exceeded" });
    expect(freeModelHealth()[ULTRA]).toMatchObject({ state: "busy" });
  });

  it("calls a 200 JSON refusal that names no status a bad gateway", async () => {
    serve(json200({ success: false, error: { code: "upstream_provider_unavailable", message: "AI provider unavailable" } }));
    await expect(collect(ULTRA)).rejects.toMatchObject({ status: 502, kind: "busy", code: "upstream_provider_unavailable" });
    // A model that takes no tools is still told apart by what the refusal says.
    serve(json200({ success: false, error: "Model does not support tools" }));
    await expect(collect(ULTRA)).rejects.toMatchObject({ kind: "no_tools", upstream: "Model does not support tools" });
  });

  it("does the same for a one-shot call", async () => {
    serve(json200({ success: false, error: { code: "upstream_rate_limited", message: "AI provider rate limit exceeded", status: 429 } }));
    await expect(puterComplete([{ role: "user", content: "hi" }], { model: ULTRA, retries: 1 })).rejects.toMatchObject({ status: 429, kind: "busy", code: "upstream_rate_limited" });
    resetFreeModelHealth();
    serve(json200({ success: false, error: { message: "Rate limit exceeded: free-models-per-day-high-balance", code: 429 } }));
    await expect(puterComplete([{ role: "user", content: "hi" }], { model: ULTRA })).rejects.toMatchObject({ status: 429, kind: "daily_limit" });
    expect(calls).toHaveLength(1);
    expect(freeModelHealth()[ULTRA]).toMatchObject({ state: "daily_limit" });
  });

  it("moves a model with a second route onto it when the main route's stream opens with a refusal", async () => {
    const GEMMA = PUTER_MODELS["gemma-26b"];
    serve(lines({ success: false, error: { message: "Rate limit exceeded: free-models-per-day-high-balance", code: 429 } }), stream("From the second route"), stream("Again"));
    const events = await collect(GEMMA);
    expect(events.some((event) => event.type === "text" && event.text === "From the second route")).toBe(true);
    await collect(GEMMA);
    expect(calls.map((call) => call.model)).toEqual([GEMMA, "gemma-4-26b-a4b-it", "gemma-4-26b-a4b-it"]);
  });

  it("does not start over on the second route once part of the reply has reached the person", async () => {
    const GEMMA = PUTER_MODELS["gemma-26b"];
    serve(lines({ type: "text", text: "Half an ans" }, { success: false, error: { message: "AI provider rate limit exceeded", code: "upstream_rate_limited", status: 429 } }), stream("unused"));
    const events: PuterStreamEvent[] = [];
    const run = (async () => {
      for await (const event of puterStream([{ role: "user", content: "hi" }], { model: GEMMA })) events.push(event);
    })();
    await expect(run).rejects.toMatchObject({ kind: "busy", status: 429 });
    expect(events).toEqual([{ type: "text", text: "Half an ans" }]);
    expect(calls).toHaveLength(1);
  });
});

describe("the app-id pool", () => {
  it("stops growing at its ceiling, however many rate limits come back", async () => {
    serve(...Array.from({ length: 40 }, () => refusal(429, BUSY)));
    for (let i = 0; i < 40; i += 1) await expect(collect(PUTER_MODELS["flint"])).rejects.toMatchObject({ kind: "busy" });
    expect(calls).toHaveLength(40);
    const pool = appIdPoolStats();
    expect(pool.total).toBeLessThanOrEqual(APP_ID_POOL_MAX);
    expect(APP_ID_POOL_MAX).toBeLessThanOrEqual(500);
    // The pool still has ids that are not resting.
    expect(pool.active).toBeGreaterThan(0);
  });
});

const SLOW_DOWN = JSON.stringify({
  error: "Too many AI requests from this account, network or device. Try again in a minute.",
  message: "Too many AI requests from this account, network or device. Try again in a minute.",
  code: "too_many_requests",
});

describe("the service's own rate limit", () => {
  it("is told apart from a busy model, with the wait the service named", () => {
    const error = new PuterHttpError(429, SLOW_DOWN);
    expect(error.kind).toBe("busy");
    expect(error.slowDown).toBe(true);
    expect(error.retryAfterMs).toBe(60_000);
    expect(new PuterHttpError(429, JSON.stringify({ error: "Too many AI requests. Try again in 30 seconds.", code: "too_many_requests" })).retryAfterMs).toBe(30_000);
    expect(new PuterHttpError(429, JSON.stringify({ error: "Too many AI requests from this device. Try again in 2 minutes." })).retryAfterMs).toBe(120_000);
    // Said without a time: a minute. Said with an absurd one: never more than five.
    expect(new PuterHttpError(429, JSON.stringify({ code: "too_many_requests" })).retryAfterMs).toBe(60_000);
    expect(new PuterHttpError(429, JSON.stringify({ error: "Too many AI requests. Try again in 500 minutes." })).retryAfterMs).toBe(300_000);
    // A busy provider is not a slow-down, and a daily limit stays a daily limit.
    expect(new PuterHttpError(429, BUSY).slowDown).toBe(false);
    expect(new PuterHttpError(429, BUSY).retryAfterMs).toBeNull();
    expect(new PuterHttpError(429, DAILY_LIMIT).kind).toBe("daily_limit");
    expect(new PuterHttpError(429, DAILY_LIMIT).slowDown).toBe(false);
  });

  it("says it is the service, not the model, and that another model will not help", () => {
    const message = describePuterError(new PuterHttpError(429, SLOW_DOWN), "Gemma 4 31B", 2).message;
    expect(message).toContain("The free AI service asked Automa to slow down");
    expect(message).toContain("Automa waited and asked again 2 times");
    expect(message).toContain("Another model will not answer sooner");
    expect(message).not.toContain("Gemma 4 31B");
    expect(message).not.toContain("busy at its provider");
  });

  it("holds every later call until the wait is over, whatever its model", async () => {
    vi.useFakeTimers();
    try {
      serve(refusal(429, SLOW_DOWN), stream("Hello"));
      await expect(collect(PUTER_MODELS["deepseek-flash"])).rejects.toMatchObject({ slowDown: true, kind: "busy" });
      expect(freeServiceSlowDownMs()).toBeGreaterThan(59_000);
      // Another model, asked while the limit stands, is not sent: it would only be refused too.
      const later = collect(PUTER_MODELS["bonsai-27b"]);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(16_000);
      const events = await later;
      expect(calls).toHaveLength(2);
      expect(events.some((event) => event.type === "text" && event.text === "Hello")).toBe(true);
      expect(freeServiceSlowDownMs()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets calls held together go out one after another, not in one burst", async () => {
    vi.useFakeTimers();
    try {
      serve(refusal(429, SLOW_DOWN), stream("one"), stream("two"), stream("three"));
      await expect(collect(PUTER_MODELS["deepseek-flash"])).rejects.toMatchObject({ slowDown: true });
      const held = [collect(PUTER_MODELS["bonsai-27b"]), collect(PUTER_MODELS["deepseek-flash"]), collect(PUTER_MODELS["gemma-31b"])];
      await vi.advanceTimersByTimeAsync(60_100);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1500);
      expect(calls).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1500);
      expect(calls).toHaveLength(4);
      await Promise.all(held);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call the model busy, nor move it to its second route", async () => {
    vi.useFakeTimers();
    try {
      serve(refusal(429, SLOW_DOWN), stream("Hello"));
      await expect(collect(PUTER_MODELS["gemma-31b"])).rejects.toMatchObject({ slowDown: true });
      // One call only: a busy Gemma is asked again over Google's route at once, a slow-down is not.
      expect(calls).toHaveLength(1);
      expect(freeModelHealth()[PUTER_MODELS["gemma-31b"]]).toBeUndefined();
      const again = collect(PUTER_MODELS["gemma-31b"]);
      await vi.advanceTimersByTimeAsync(61_000);
      await again;
      expect(calls.map((call) => call.model)).toEqual([PUTER_MODELS["gemma-31b"], PUTER_MODELS["gemma-31b"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds one-shot calls too, and lets a caller stop while it waits", async () => {
    vi.useFakeTimers();
    try {
      serve(refusal(429, SLOW_DOWN), chatReply("ready"));
      await expect(collect(PUTER_MODELS["deepseek-flash"])).rejects.toMatchObject({ slowDown: true });
      const stop = new AbortController();
      const stopped = puterComplete([{ role: "user", content: "hi" }], { model: PUTER_MODELS["bonsai-27b"], retries: 1, signal: stop.signal });
      const outcome = stopped.then(() => "answered", (error: unknown) => (error as Error).name);
      await vi.advanceTimersByTimeAsync(10_000);
      stop.abort();
      expect(await outcome).toBe("AbortError");
      expect(calls).toHaveLength(1);
      // The next caller waits the rest of the minute and is answered.
      const answered = puterComplete([{ role: "user", content: "hi" }], { model: PUTER_MODELS["bonsai-27b"], retries: 1 });
      await vi.advanceTimersByTimeAsync(51_000);
      expect((await answered).text).toBe("ready");
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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
    // The model answered, over its second route: health says it answers, not that it is busy.
    const health = freeModelHealth()[PUTER_MODELS["gemma-31b"]];
    expect(health).toMatchObject({ state: "ok", last: "ok" });
    expect(freeModelAnswering(health)).toBe(true);
    // The main route is still held as busy, so the next call goes straight to the second route.
    serve(stream("Hello again"));
    await collect(PUTER_MODELS["gemma-31b"]);
    expect(calls.map((call) => call.model)).toEqual(["gemma-4-31b-it"]);
    expect(freeModelHealth()[PUTER_MODELS["gemma-31b"]]).toMatchObject({ state: "ok", last: "ok" });
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

describe("freeModelAllowance", () => {
  beforeEach(() => resetFreeModelAllowance());

  const REPORT = {
    usage: {
      total: 366,
      "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free:request": { units: 186, cost: 0, count: 186 },
      "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free:prompt": { units: 90000, cost: 0, count: 186 },
      "infron:qwen/qwen3_dot_8-27b:free:request": { units: 13, cost: 0, count: 13 },
      "togetherai:prism-ml/ternary-bonsai-27b:prompt": { units: 400, cost: 0, count: 4 },
      "google:gemma-4-31b-it:request": { units: 2, cost: 0, count: 2 },
      "openrouter:google/gemma-4-31b-it:free:request": { units: 5, cost: 0, count: 5 },
      "openrouter:openrouter/free:request": { units: 21, cost: 0, count: 21 },
      "claude:claude-fable-5-1:output_tokens": { units: 500, cost: 106, count: 3 },
      "egress:bytes": { units: 1000, cost: 3, count: 40 },
    },
    appTotals: {},
    allowanceInfo: { remaining: 633.93, monthUsageAllowance: 1000, unit: "credits" },
  };

  it("reads the month's allowance and counts requests by Automa's own model ids", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => new Response(JSON.stringify(REPORT), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const allowance = await freeModelAllowance();
    expect(allowance).toMatchObject({ allowance: 1000, remaining: 633.93, unit: "credits" });
    expect(allowance.requestsByModel).toEqual({
      [PUTER_MODELS["nemotron-ultra"]]: 186,
      [PUTER_MODELS["qwen-27b"]]: 13,
      [PUTER_MODELS["bonsai-27b"]]: 4,
      [PUTER_MODELS["gemma-31b"]]: 7,
      [PUTER_MODELS["free-router"]]: 21,
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.puter.com/metering/usage");
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toMatch(/^Bearer .{20,}/);
    // Kept for a minute: a second look asks nothing new.
    await freeModelAllowance();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails without the token in the message", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { headers: Record<string, string> }) =>
      new Response(`denied for ${init.headers.Authorization.slice(7)}`, { status: 401 })));
    const error = (await freeModelAllowance().catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(PuterHttpError);
    expect(error.message).toContain("401");
    expect(error.message).toContain("[hidden]");
  });

  it("refuses a report without an allowance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ usage: {} }), { status: 200 })));
    await expect(freeModelAllowance()).rejects.toThrow(/no allowance/);
  });
});

describe("the built-in free-model token at rest", () => {
  beforeEach(() => resetFreeModelAllowance());
  afterEach(() => vi.unstubAllEnvs());

  // The token is only ever seen the way the service sees it: in a request's
  // Authorization header. Nothing here prints it.
  async function tokenAsSent(): Promise<string> {
    vi.stubEnv("PUTER_AUTH_TOKEN", "");
    let header = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      header = init.headers.Authorization;
      return new Response(JSON.stringify({ usage: {}, allowanceInfo: { remaining: 1, monthUsageAllowance: 1 } }), { status: 200 });
    }));
    await freeModelAllowance();
    expect(header.startsWith("Bearer ")).toBe(true);
    return header.slice("Bearer ".length);
  }

  it("unmasks to a well-formed token when a request is made", async () => {
    const token = await tokenAsSent();
    // Three base64url parts: a wrong mask would give bytes, not this shape.
    expect(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)).toBe(true);
    expect(token.length).toBeGreaterThan(100);
  });

  it("is not in the source, whole or in pieces", async () => {
    const token = await tokenAsSent();
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./puter-ai.ts", import.meta.url), "utf8");
    expect(source.includes(token)).toBe(false);
    // An earlier build split the token into short strings joined at run time:
    // no 12-character run of it may appear anywhere in the file.
    const [, payload, signature] = token.split(".");
    const pieces: string[] = [];
    for (const part of [payload!, signature!]) {
      for (let at = 0; at + 12 <= part.length; at += 1) pieces.push(part.slice(at, at + 12));
    }
    expect(pieces.length).toBeGreaterThan(50);
    expect(pieces.filter((piece) => source.includes(piece)).length).toBe(0);
  });

  it("an operator's own token wins over the built-in one", async () => {
    vi.stubEnv("PUTER_AUTH_TOKEN", "operator-token-for-this-test");
    let header = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      header = init.headers.Authorization;
      return new Response(JSON.stringify({ usage: {}, allowanceInfo: { remaining: 1, monthUsageAllowance: 1 } }), { status: 200 });
    }));
    await freeModelAllowance();
    expect(header).toBe("Bearer operator-token-for-this-test");
  });
});
