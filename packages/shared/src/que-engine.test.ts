import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUTER_MODELS, puterChat, puterStream, resetFreeModelHealth } from "./puter-ai.js";
import {
  queBatch,
  queChat,
  queClearConversations,
  queConversation,
  queConversations,
  queConvo,
  queModelId,
  queStats,
  resetQue,
} from "./que-engine.js";
import { QUE_PER_MODEL_IN_FLIGHT } from "./que.js";
import { queQueueStats, queTurn, resetQueQueueStats } from "./que-queue.js";

const ULTRA = PUTER_MODELS["nemotron-ultra"];
const DEEPSEEK = PUTER_MODELS["deepseek-flash"];
const QWEN = PUTER_MODELS["qwen-27b"];
const DAILY_LIMIT = JSON.stringify({
  error: "AI provider rate limit exceeded",
  code: "upstream_rate_limited",
  attempts: [{ status: 429, error: "429 Free model daily limit exceeded (1000 requests per day). Please try again after 5368 seconds." }],
});
const BUSY = JSON.stringify({ error: "AI provider rate limit exceeded", code: "upstream_rate_limited", attempts: [{ status: 429, error: "429 Provider returned error" }] });

function stream(text: string) {
  const lines = [
    JSON.stringify({ type: "text", text }),
    JSON.stringify({ type: "usage", usage: { prompt: 5, completion: 7, usd_cents: 0 }, usageDetails: { inputTokens: 5, outputTokens: 7 }, stopReason: "end_turn" }),
  ];
  return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
const refusal = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } });

type Sent = { model: string; messages: Array<{ role: string; content: string }> };
let calls: Sent[] = [];
function serve(...replies: Response[]) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    calls.push((JSON.parse(init.body) as { args: Sent }).args);
    const next = replies.shift();
    if (!next) throw new Error("no reply scripted");
    return next;
  }));
}

beforeEach(() => {
  resetFreeModelHealth();
  resetQue();
  resetQueQueueStats();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Que queue", () => {
  it("lets 10 calls run at once and the rest wait their turn, in order", async () => {
    const running = await Promise.all(Array.from({ length: 10 }, () => queTurn()));
    const order: number[] = [];
    const waiting = [1, 2, 3].map((n) => queTurn().then((release) => {
      order.push(n);
      return release;
    }));
    expect(queQueueStats()).toMatchObject({ maxInFlight: 10, inFlight: 10, waiting: 3 });
    running[0]!();
    running[0]!(); // ending a turn twice frees one place, not two
    const first = await waiting[0]!;
    expect(order).toEqual([1]);
    expect(queQueueStats()).toMatchObject({ inFlight: 10, waiting: 2 });
    for (const release of running.slice(1, 3)) release();
    const rest = await Promise.all(waiting.slice(1));
    expect(order).toEqual([1, 2, 3]);
    for (const release of [first, ...rest, ...running.slice(3)]) release();
    expect(queQueueStats()).toMatchObject({ inFlight: 0, waiting: 0, started: 13, peakInFlight: 10 });
  });

  it("lets a caller that gives up leave the line", async () => {
    const running = await Promise.all(Array.from({ length: 10 }, () => queTurn()));
    const controller = new AbortController();
    const leaving = queTurn(controller.signal);
    const staying = queTurn();
    controller.abort();
    await expect(leaving).rejects.toThrow(/abort/i);
    running[0]!();
    const release = await staying;
    release();
    for (const end of running.slice(1)) end();
    expect(queQueueStats()).toMatchObject({ inFlight: 0, waiting: 0 });
  });

  it("puts every free-model call through the queue: a stream holds its turn until it ends", async () => {
    serve(stream("hello"), stream("again"));
    const events = puterStream([{ role: "user", content: "hi" }], { model: ULTRA });
    expect((await events.next()).value).toEqual({ type: "text", text: "hello" });
    expect(queQueueStats().inFlight).toBe(1);
    for await (const _event of events) { /* drain */ }
    expect(queQueueStats().inFlight).toBe(0);
    // A reader that stops early frees its turn too.
    for await (const _event of puterStream([{ role: "user", content: "hi" }], { model: ULTRA })) break;
    expect(queQueueStats()).toMatchObject({ inFlight: 0, started: 2 });
  });

  it("queues one-shot calls too", async () => {
    serve(new Response(JSON.stringify({ success: true, result: { message: { content: "hey" } } }), { status: 200 }));
    expect(await puterChat("hi")).toBe("hey");
    expect(queQueueStats()).toMatchObject({ inFlight: 0, started: 1 });
  });

  it("does not make a model held at its daily limit wait in line", async () => {
    serve(refusal(429, DAILY_LIMIT));
    await expect(queChat("hi", { model: "deepseek", fallback: false })).rejects.toThrow("used up today's free requests");
    await expect(queChat("hi again", { model: "deepseek", fallback: false })).rejects.toThrow("used up today's free requests");
    expect(calls).toHaveLength(1);
    expect(queQueueStats().started).toBe(1);
  });

  it("holds any one model to its own limit, while other models still run in parallel", async () => {
    const releases = await Promise.all([
      queTurn(undefined, "model-a"),
      queTurn(undefined, "model-a"),
      queTurn(undefined, "model-b"),
    ]);
    expect(queQueueStats()).toMatchObject({ inFlight: 3, waiting: 0 });
    // A third call to model-a waits, though the queue has room and model-b is free.
    const order: string[] = [];
    const thirdA = queTurn(undefined, "model-a").then((release) => {
      order.push("a3");
      return release;
    });
    const anotherB = queTurn(undefined, "model-b").then((release) => {
      order.push("b2");
      return release;
    });
    const secondB = await anotherB;
    expect(order).toEqual(["b2"]);
    expect(queQueueStats()).toMatchObject({ inFlight: 4, waiting: 1 });
    releases[0]!(); // free one model-a slot
    const thirdARelease = await thirdA;
    expect(order).toEqual(["b2", "a3"]);
    for (const release of [...releases.slice(1), secondB, thirdARelease]) release();
    expect(queQueueStats()).toMatchObject({ inFlight: 0, waiting: 0 });
  });

  it("answers 20 questions on one model two at a time (the service's per-model limit), dropping none", async () => {
    let open = 0;
    let most = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      const { messages } = (JSON.parse(init.body) as { args: Sent }).args;
      return stream(`answer to ${messages.at(-1)!.content}`);
    }));
    const prompts = Array.from({ length: 20 }, (_, i) => `q${i}`);
    const results = await queBatch(prompts, { cache: false });
    expect(results.map((result) => ("text" in result ? result.text : result.error))).toEqual(prompts.map((p) => `answer to ${p}`));
    expect(most).toBe(QUE_PER_MODEL_IN_FLIGHT);
    expect(queQueueStats()).toMatchObject({ inFlight: 0, waiting: 0, started: 20, peakInFlight: QUE_PER_MODEL_IN_FLIGHT });
  });
});

describe("Que answers", () => {
  it("answers the same question again from the cache, kept per company", async () => {
    serve(stream("Kingston"), stream("Kingston, Jamaica"));
    const first = await queChat("Capital of Jamaica?", { scope: "company-a" });
    const again = await queChat("Capital of Jamaica?", { scope: "company-a" });
    const other = await queChat("Capital of Jamaica?", { scope: "company-b" });
    expect(first).toMatchObject({ text: "Kingston", cached: false, attempts: 1, model: ULTRA, requestedModel: ULTRA });
    expect(again).toMatchObject({ text: "Kingston", cached: true, attempts: 0 });
    expect(other).toMatchObject({ text: "Kingston, Jamaica", cached: false });
    expect(calls).toHaveLength(2);
    expect(queStats({ scope: "company-a" })).toMatchObject({ cachedAnswers: 1, cacheHits: 1 });
  });

  it("asks again after five minutes, or whenever the cache is turned off", async () => {
    serve(stream("one"), stream("two"), stream("three"));
    const now = Date.now();
    await queChat("Q");
    expect((await queChat("Q", { cache: false })).text).toBe("two");
    vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60_000 + 1);
    expect((await queChat("Q")).text).toBe("three");
  });

  it("asks a busy model again before handing the question over", async () => {
    serve(refusal(429, BUSY), refusal(429, BUSY), stream("ok"));
    expect(await queChat("hi", { model: "qwen", cache: false })).toMatchObject({ text: "ok", model: QWEN, attempts: 3 });
  });

  it("hands the question to the next free model after three busy tries, and says who answered", async () => {
    serve(refusal(429, BUSY), refusal(429, BUSY), refusal(429, BUSY), stream("ok"));
    const answer = await queChat("hi", { model: "qwen", cache: false });
    expect(calls.map((call) => call.model)).toEqual([QWEN, QWEN, QWEN, ULTRA]);
    expect(answer).toMatchObject({ text: "ok", model: ULTRA, requestedModel: QWEN, attempts: 4 });
  });

  it("hands over to a model that is answering before one that was busy a moment ago", async () => {
    serve(refusal(429, BUSY));
    const busyUltra = async () => {
      for await (const _event of puterStream([{ role: "user", content: "hi" }], { model: ULTRA })) { /* refused */ }
    };
    await expect(busyUltra()).rejects.toMatchObject({ kind: "busy" });
    serve(refusal(429, BUSY), refusal(429, BUSY), refusal(429, BUSY), stream("ok"));
    const answer = await queChat("hi", { model: "qwen", cache: false });
    expect(calls.map((call) => call.model)).toEqual([QWEN, QWEN, QWEN, PUTER_MODELS["nemotron-super"]]);
    expect(answer.model).toBe(PUTER_MODELS["nemotron-super"]);
  });

  it("hands over at once from a model at its daily limit, and skips it until the reset", async () => {
    serve(refusal(429, DAILY_LIMIT), stream("Kingston"));
    expect(await queChat("Capital?", { model: "deepseek", cache: false })).toMatchObject({ text: "Kingston", model: ULTRA, requestedModel: DEEPSEEK });
    serve(stream("Montego Bay"));
    expect((await queChat("Second city?", { model: "deepseek", cache: false })).text).toBe("Montego Bay");
    expect(calls.map((call) => call.model)).toEqual([ULTRA]);
  });

  it("stays on the model when fallback is off, saying why it can't answer", async () => {
    serve(refusal(429, DAILY_LIMIT));
    await expect(queChat("hi", { model: "deepseek", fallback: false })).rejects.toThrow("DeepSeek V4.1 Flash has used up today's free requests");
    expect(calls).toHaveLength(1);
  });

  it("never gives an exact-model call an answer another model gave in its place", async () => {
    serve(refusal(429, DAILY_LIMIT), stream("from Nemotron"));
    await queChat("Q", { model: "deepseek" });
    await expect(queChat("Q", { model: "deepseek", fallback: false })).rejects.toThrow("used up today's free requests");
  });

  it("keeps a question for the safety classifier on the classifier, as a readable verdict", async () => {
    serve(stream("User Safety: safe"));
    expect((await queChat("Is this message ok?", { model: "safety" })).text).toBe("**Safety check: safe.** Nothing harmful found in the message.");
    serve(refusal(429, DAILY_LIMIT));
    await expect(queChat("And this one?", { model: "safety" })).rejects.toThrow("used up today's free requests");
    expect(calls).toHaveLength(1);
  });

  it("says so when no free model can answer", async () => {
    serve(...Array.from({ length: 8 }, () => refusal(429, BUSY)));
    await expect(queChat("hi", { model: "qwen", cache: false })).rejects.toThrow("The other free models couldn't answer right now either");
    expect(calls).toHaveLength(8);
  });

  it("puts the system message and the think instruction in one system message", async () => {
    serve(stream("ok"));
    await queChat("Explain tides", { system: "You are a teacher.", think: "deep" });
    expect(calls[0]!.messages).toEqual([
      { role: "system", content: "You are a teacher.\n\nThink step by step. Show your reasoning before answering." },
      { role: "user", content: "Explain tides" },
    ]);
  });

  it("moves thinking written inline into the reasoning", async () => {
    serve(stream("<think>Two plus two.</think>\n4"));
    expect(await queChat("2+2?")).toMatchObject({ text: "4", reasoning: "Two plus two." });
  });

  it("knows the free models by id, catalog key and Que short name, and nothing else", async () => {
    expect(queModelId("ultra")).toBe(ULTRA);
    expect(queModelId("deepseek-flash")).toBe(DEEPSEEK);
    expect(queModelId(DEEPSEEK)).toBe(DEEPSEEK);
    expect(queModelId(undefined)).toBe(ULTRA);
    expect(queModelId("toString")).toBeNull();
    expect(queModelId("openai/gpt-6.1-terra")).toBeNull();
    await expect(queChat("hi", { model: "openai/gpt-6.1-terra" })).rejects.toThrow("is not one of Automa's free models");
  });

  it("reports one failed question in a batch without failing the rest", async () => {
    serve(stream("A"), refusal(400, JSON.stringify({ error: "Unsupported parameter" })));
    const results = await queBatch(["one", "two"], { model: "qwen", fallback: false, cache: false });
    expect(results[0]).toMatchObject({ text: "A" });
    expect(results[1]).toEqual({ error: expect.stringContaining("rejected the request") });
  });
});

describe("Que conversations", () => {
  const ann = { scope: "company-1", owner: "user:ann" };

  it("keeps each person's conversation, and a failed message leaves it as it was", async () => {
    serve(stream("Hi Ann!"), refusal(400, JSON.stringify({ error: "Unsupported parameter" })), stream("Your name is Ann."));
    await queConvo("I'm Ann", "chat", ann);
    await expect(queConvo("(broken)", "chat", { ...ann, fallback: false })).rejects.toThrow();
    expect((await queConvo("What's my name?", "chat", ann)).text).toBe("Your name is Ann.");
    expect(calls[2]!.messages.map((message) => message.content)).toEqual(["I'm Ann", "Hi Ann!", "What's my name?"]);
    expect(queConversation("chat", ann)!.messages).toHaveLength(4);
    expect(queConversation("chat", { scope: "company-1", owner: "user:ben" })).toBeNull();
    expect(queConversation("chat", { scope: "company-2", owner: "user:ann" })).toBeNull();
    expect(queConversations(ann).map((convo) => convo.id)).toEqual(["chat"]);
    expect(queStats(ann).conversations).toBe(1);
    expect(queClearConversations(ann)).toBe(1);
    expect(queConversations(ann)).toEqual([]);
  });

  it("answers messages to one conversation one at a time, in order", async () => {
    serve(stream("one"), stream("two"));
    await Promise.all([queConvo("first", "x", ann), queConvo("second", "x", ann)]);
    expect(calls[1]!.messages.map((message) => message.content)).toEqual(["first", "one", "second"]);
  });
});
