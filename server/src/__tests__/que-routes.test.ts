import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUTER_MODELS, resetFreeModelHealth } from "@paperclipai/shared/puter-ai";
import { resetQue } from "@paperclipai/shared/que-engine";
import { errorHandler } from "../middleware/index.js";
import { queRoutes } from "../routes/que.js";

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

function appAs(userId: string, companyIds = [COMPANY]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId, companyIds };
    next();
  });
  app.use("/api", queRoutes({} as never));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  resetFreeModelHealth();
  resetQue();
});
afterEach(() => vi.unstubAllGlobals());

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
    expect((await request(app).post(`/api/companies/${COMPANY}/que/chat`).send({})).status).toBe(400);
    expect((await request(app).post(`/api/companies/${COMPANY}/que/batch`).send({ prompts: Array.from({ length: 21 }, () => "q") })).status).toBe(400);
    expect((await request(app).get(`/api/companies/${COMPANY}/que/conversations/bad%20id`)).status).toBe(400);
  });

  it("answers 503 with the reason when the model can't answer and fallback is off", async () => {
    serve(new Response(DAILY_LIMIT, { status: 429, headers: { "content-type": "application/json" } }));
    const res = await request(appAs("ann")).post(`/api/companies/${COMPANY}/que/chat`).send({ prompt: "hi", model: "deepseek", fallback: false });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("DeepSeek V4.1 Flash has used up today's free requests");
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
