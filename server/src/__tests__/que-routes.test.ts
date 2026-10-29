import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOAN_MODEL_ID } from "@paperclipai/shared";
import { PUTER_MODELS, resetFreeModelHealth } from "@paperclipai/shared/puter-ai";
import { queStats, resetQue } from "@paperclipai/shared/que-engine";
import { errorHandler } from "../middleware/index.js";
import { queRoutes } from "../routes/que.js";

const sinks = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("../sentry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sentry.js")>()),
  captureException: sinks.captureException,
}));

const COMPANY = "company-que";
const DAILY_LIMIT = JSON.stringify({
  error: "AI provider rate limit exceeded",
  code: "upstream_rate_limited",
  attempts: [{ status: 429, error: "429 Free model daily limit exceeded (1000 requests per day). Please try again after 600 seconds." }],
});

function stream(text: string) {
  const lines = [JSON.stringify({ type: "text", text }), JSON.stringify({ type: "usage", usageDetails: { inputTokens: 3, outputTokens: 2 } })];
  return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

let sent: Array<{ model: string; messages: Array<{ content: string }> }> = [];
function serve(...replies: Response[]) {
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    sent.push((JSON.parse(init.body) as { args: { model: string; messages: Array<{ content: string }> } }).args);
    const next = replies.shift();
    if (!next) throw new Error("no reply scripted");
    return next;
  }));
}

function appAs(userId: string, companyIds = [COMPANY], membershipRole?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "session",
      userId,
      companyIds,
      ...(membershipRole ? { memberships: companyIds.map((companyId) => ({ companyId, membershipRole, status: "active" })) } : {}),
    };
    next();
  });
  app.use("/api", queRoutes({} as never));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  resetFreeModelHealth();
  resetQue();
  sinks.captureException.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Que routes", () => {
  it("answers a question, then the same question from the cache", async () => {
    serve(stream("Kingston"));
    const app = appAs("ann");
    const first = await request(app).post(`/api/companies/${COMPANY}/que/chat`).send({ prompt: "Capital of Jamaica?", model: "ultra" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ text: "Kingston", model: PUTER_MODELS["nemotron-ultra"], cached: false });
    const again = await request(app).post(`/api/companies/${COMPANY}/que/chat`).send({ prompt: "Capital of Jamaica?", model: "ultra" });
    expect(again.body).toMatchObject({ text: "Kingston", cached: true });
    expect(sent).toHaveLength(1);
    const stats = await request(app).get(`/api/companies/${COMPANY}/que/stats`);
    expect(stats.body).toMatchObject({ maxInFlight: 10, inFlight: 0, waiting: 0, cachedAnswers: 1, cacheHits: 1 });
  });

  it("refuses other companies, paid or unknown models and malformed requests", async () => {
    const app = appAs("ann");
    expect((await request(appAs("ann", ["other"])).post(`/api/companies/${COMPANY}/que/chat`).send({ prompt: "hi" })).status).toBe(403);
    expect((await request(app).post(`/api/companies/${COMPANY}/que/chat`).send({ prompt: "hi", model: "openai/gpt-6.1-terra" })).status).toBe(400);
    // Listed among the free models, but it answers in agent chats, not through Que.
    const moan = await request(app).post(`/api/companies/${COMPANY}/que/chat`).send({ prompt: "hi", model: MOAN_MODEL_ID });
    expect(moan.status).toBe(400);
    expect(moan.body.error).toBe(`"${MOAN_MODEL_ID}" is not one of the free chat models Que can ask`);
    // A viewer can look, but not spend the shared free allowance.
    const viewer = appAs("vic", [COMPANY], "viewer");
    expect((await request(viewer).get(`/api/companies/${COMPANY}/que/stats`)).status).toBe(200);
    expect((await request(viewer).post(`/api/companies/${COMPANY}/que/chat`).send({ prompt: "hi" })).status).toBe(403);
    expect((await request(viewer).post(`/api/companies/${COMPANY}/que/batch`).send({ prompts: ["hi"] })).status).toBe(403);
    expect((await request(app).post(`/api/companies/${COMPANY}/que/chat`).send({})).status).toBe(400);
    expect((await request(app).post(`/api/companies/${COMPANY}/que/batch`).send({ prompts: Array.from({ length: 21 }, () => "q") })).status).toBe(400);
    expect((await request(app).get(`/api/companies/${COMPANY}/que/conversations/bad%20id`)).status).toBe(400);
  });

  it("answers 503 with the reason when the model can't answer and fallback is off", async () => {
    serve(new Response(DAILY_LIMIT, { status: 429, headers: { "content-type": "application/json" } }));
    const res = await request(appAs("ann")).post(`/api/companies/${COMPANY}/que/chat`).send({ prompt: "hi", model: "deepseek", fallback: false });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("DeepSeek V4.1 Flash has used up today's free requests");
    // A model at its limit is not a server crash.
    expect(sinks.captureException).not.toHaveBeenCalled();
  });

  it("stops the call when the client goes away, without a crash report", async () => {
    let upstream: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      upstream = init.signal;
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })));
    const server = appAs("ann").listen(0);
    try {
      const client = http.request({
        port: (server.address() as AddressInfo).port,
        method: "POST",
        path: `/api/companies/${COMPANY}/que/chat`,
        headers: { "content-type": "application/json" },
      });
      client.on("error", () => undefined);
      client.end(JSON.stringify({ prompt: "hi", model: "deepseek", cache: false }));
      await vi.waitFor(() => expect(upstream).toBeDefined());
      expect(queStats({ scope: COMPANY }).inFlight).toBe(1);
      client.destroy();
      await vi.waitFor(() => expect(upstream?.aborted).toBe(true));
      await vi.waitFor(() => expect(queStats({ scope: COMPANY })).toMatchObject({ inFlight: 0, waiting: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sinks.captureException).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("lets each person or agent ask 30 questions a minute, then answers 429 with when to ask again", async () => {
    let now = Date.parse("2026-10-29T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    serve(...Array.from({ length: 21 }, () => stream("ok")));
    const app = appAs("ann");
    const chat = `/api/companies/${COMPANY}/que/chat`;
    const batch = `/api/companies/${COMPANY}/que/batch`;
    const prompts = (count: number) => Array.from({ length: count }, (_, i) => `question ${i}`);
    expect((await request(app).post(batch).send({ prompts: prompts(20), cache: false })).status).toBe(200);
    now += 30_000;
    // Answers from the cache count too: each is a question asked.
    for (let i = 0; i < 10; i += 1) expect((await request(app).post(chat).send({ prompt: "same" })).status).toBe(200);
    now += 10_000;
    const refused = await request(app).post(batch).send({ prompts: ["same", "same", "same", "same", "same"] });
    expect(refused.status).toBe(429);
    // Five of the 20 asked at the start must leave the minute first: 20 seconds from now.
    expect(refused.headers["retry-after"]).toBe("20");
    expect(refused.body.error).toBe("Que answers up to 30 questions a minute from each person or agent, counting each prompt in a batch, because the free models are shared by everyone on Automa. Ask again in 20 seconds.");
    expect((await request(app).post(chat).send({ prompt: "same" })).status).toBe(429);
    expect((await request(app).post(`/api/companies/${COMPANY}/que/conversations/talk`).send({ prompt: "same" })).status).toBe(429);
    // Someone else has their own minute.
    expect((await request(appAs("ben")).post(chat).send({ prompt: "same" })).status).toBe(200);
    // Once the first 20 leave the minute, 20 fit again: the refused questions spent none of it.
    now += 20_001;
    expect((await request(app).post(batch).send({ prompts: Array.from({ length: 20 }, () => "same") })).status).toBe(200);
    expect(sent).toHaveLength(21);
  });

  it("answers a batch in order", async () => {
    serve(stream("one"), stream("two"));
    const res = await request(appAs("ann")).post(`/api/companies/${COMPANY}/que/batch`).send({ prompts: ["a", "b"], cache: false });
    expect(res.status).toBe(200);
    expect(res.body.results.map((item: { text: string }) => item.text)).toEqual(["one", "two"]);
  });

  it("keeps conversations per person", async () => {
    serve(stream("Hi Ann!"), stream("Your name is Ann."));
    const ann = appAs("ann");
    const path = `/api/companies/${COMPANY}/que/conversations/intro`;
    expect((await request(ann).post(path).send({ prompt: "I'm Ann" })).body.answer.text).toBe("Hi Ann!");
    const second = await request(ann).post(path).send({ prompt: "What's my name?" });
    expect(second.body.conversation.messages.map((m: { content: string }) => m.content)).toEqual(["I'm Ann", "Hi Ann!", "What's my name?", "Your name is Ann."]);
    expect((await request(ann).get(`/api/companies/${COMPANY}/que/conversations`)).body.map((c: { id: string }) => c.id)).toEqual(["intro"]);
    const ben = appAs("ben");
    expect((await request(ben).get(path)).status).toBe(404);
    expect((await request(ben).get(`/api/companies/${COMPANY}/que/conversations`)).body).toEqual([]);
    expect((await request(ben).delete(path)).status).toBe(404);
    expect((await request(ann).delete(path)).body).toEqual({ ok: true });
    expect((await request(ann).get(path)).status).toBe(404);
    expect((await request(ann).delete(`/api/companies/${COMPANY}/que/conversations`)).body).toEqual({ cleared: 0 });
  });
});
