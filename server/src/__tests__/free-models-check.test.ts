import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freeModelOffline } from "@paperclipai/shared";
import { freeModelHealth, PUTER_MODELS, resetFreeModelHealth } from "@paperclipai/shared/puter-ai";
import { errorHandler } from "../middleware/index.js";
import { freeModelRoutes } from "../routes/free-models.js";
import {
  checkFreeModels,
  FreeModelsUnreachableError,
  resetFreeModelCheckForTests,
  type FreeModelProbe,
} from "../services/free-models.js";

vi.mock("../services/moan/index.js", () => ({ moanKnowledge: () => ({}) }));

const ULTRA = PUTER_MODELS["nemotron-ultra"];
const SUPER = PUTER_MODELS["nemotron-super"];
const FLINT = PUTER_MODELS.flint;

/** The free service as it answers: a streamed "OK", or the refusal a provider gives for a free version it took offline. */
function serve(offline: readonly string[], options: { down?: boolean } = {}) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const model = (JSON.parse(init.body) as { args: { model: string } }).args.model;
    asked.push(model);
    if (options.down) throw new TypeError("fetch failed");
    if (offline.includes(model)) {
      return new Response(JSON.stringify({ error: `Model not found: ${model}`, code: "bad_request" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const lines = [JSON.stringify({ type: "text", text: "OK" }), JSON.stringify({ type: "usage", usage: { prompt: 5, completion: 1, usd_cents: 0 } })];
    return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  }));
  return asked;
}

beforeEach(() => {
  resetFreeModelHealth();
  resetFreeModelCheckForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe("checking which free models answer", () => {
  it("asks every model for one word and says which answered and which are offline", async () => {
    const asked = serve([SUPER]);
    const result = await checkFreeModels({ models: [ULTRA, SUPER, FLINT] });

    expect([...asked].sort()).toEqual([ULTRA, SUPER, FLINT].sort());
    expect(result.total).toBe(3);
    expect(result.answering).toBe(2);
    expect(result.health[ULTRA]).toMatchObject({ state: "ok", last: "ok" });
    expect(result.health[SUPER]).toMatchObject({ state: "withdrawn", last: "withdrawn" });
    expect(freeModelOffline(result.health[SUPER])).toBe(true);
    expect(freeModelOffline(result.health[FLINT])).toBe(false);
    // The pickers read the same record.
    expect(freeModelHealth()[SUPER]).toMatchObject({ state: "withdrawn" });
  });

  it("still says a model was offline hours later, after the engine's own five-minute hold", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
      serve([SUPER]);
      await checkFreeModels({ models: [ULTRA, SUPER] });
      vi.setSystemTime(new Date("2026-11-22T15:00:00Z"));
      const later = freeModelHealth()[SUPER]!;
      expect(later).toMatchObject({ state: "ok", until: null, last: "withdrawn", checkedAt: "2026-11-22T12:00:00.000Z" });
      expect(freeModelOffline(later)).toBe(true);
      expect(freeModelOffline(freeModelHealth()[ULTRA])).toBe(false);
      vi.setSystemTime(new Date("2026-11-23T12:00:01Z"));
      expect(freeModelOffline(freeModelHealth()[SUPER])).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks two at a time, and two people tapping at once share one check", async () => {
    let inFlight = 0;
    let most = 0;
    const asked: string[] = [];
    const ask = async (model: string): Promise<FreeModelProbe> => {
      asked.push(model);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return model === "b" ? "refused" : "answered";
    };
    const models = ["a", "b", "c", "d", "e"];
    const [first, second] = await Promise.all([checkFreeModels({ models, ask }), checkFreeModels({ models, ask })]);
    expect(first).toBe(second);
    expect(asked.sort()).toEqual(models);
    expect(most).toBe(2);
    expect(first).toMatchObject({ total: 5, answering: 4 });
  });

  it("gives the last answer to a check asked for again within a minute, then asks again", async () => {
    let clock = 1_000_000;
    const ask = vi.fn(async (): Promise<FreeModelProbe> => "answered");
    const options = { models: ["a", "b"], ask, now: () => clock };
    const first = await checkFreeModels(options);
    clock += 59_000;
    expect(await checkFreeModels(options)).toBe(first);
    expect(ask).toHaveBeenCalledTimes(2);
    clock += 2_000;
    const again = await checkFreeModels(options);
    expect(again).not.toBe(first);
    expect(ask).toHaveBeenCalledTimes(4);
  });

  it("says the service can't be reached instead of calling every model offline, and does not keep that answer", async () => {
    serve([], { down: true });
    await expect(checkFreeModels({ models: [ULTRA, FLINT] })).rejects.toBeInstanceOf(FreeModelsUnreachableError);
    expect(freeModelHealth()).toEqual({});

    serve([]);
    await expect(checkFreeModels({ models: [ULTRA, FLINT] })).resolves.toMatchObject({ total: 2, answering: 2 });
  });
});

describe("POST /free-models/health/check", () => {
  function appWith(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", freeModelRoutes({} as never));
    app.use(errorHandler);
    return app;
  }
  const board: Express.Request["actor"] = { type: "board", source: "local_implicit", userId: "local-board" };

  it("is for the board: an agent's key and a signed-out caller are refused before any model is asked", async () => {
    const asked = serve([]);
    const agent = await request(appWith({ type: "agent", source: "agent_key", agentId: "a1", companyId: "c1" })).post("/api/free-models/health/check").send({});
    expect(agent.status).toBe(403);
    const anonymous = await request(appWith({ type: "none", source: "none" })).post("/api/free-models/health/check").send({});
    expect([401, 403]).toContain(anonymous.status);
    expect(asked).toEqual([]);
  });

  it("returns every model's state and how many answer", async () => {
    serve([SUPER, PUTER_MODELS["deepseek-flash"]]);
    const response = await request(appWith(board)).post("/api/free-models/health/check").send({});
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(Object.keys(PUTER_MODELS).length);
    expect(response.body.answering).toBe(response.body.total - 2);
    expect(response.body.health[SUPER]).toMatchObject({ state: "withdrawn", last: "withdrawn" });
    expect(response.body.health[ULTRA]).toMatchObject({ state: "ok" });

    const health = await request(appWith(board)).get("/api/free-models/health");
    expect(health.body[SUPER]).toMatchObject({ last: "withdrawn" });
  });

  it("answers 502 with a plain reason when nothing can be reached", async () => {
    serve([], { down: true });
    const response = await request(appWith(board)).post("/api/free-models/health/check").send({});
    expect(response.status).toBe(502);
    expect(response.body.error).toContain("Can't reach the free models right now");
  });
});
