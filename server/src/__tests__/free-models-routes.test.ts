import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import { MOAN_MODEL_ID } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { freeModelRoutes } from "../routes/free-models.js";
import { FREE_MODELS_RESET_ACTION } from "../services/free-models.js";

const moan = vi.hoisted(() => ({
  refresh: vi.fn(async () => ({ started: true, sources: 3 })),
  status: vi.fn(async () => ({ pages: 120 })),
}));
vi.mock("../services/moan/index.js", () => ({ moanKnowledge: () => moan }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres free-model route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

function appWith(db: unknown, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", freeModelRoutes(db as never));
  app.use(errorHandler);
  return app;
}

const member = (companyId: string, membershipRole = "owner", extra: Partial<Express.Request["actor"]> = {}): Express.Request["actor"] => ({
  type: "board",
  source: "session",
  userId: `user-${membershipRole}`,
  companyIds: [companyId],
  memberships: [{ companyId, membershipRole, status: "active" }],
  ...extra,
});

describe("Moan refresh", () => {
  beforeEach(() => moan.refresh.mockClear());

  it("lets the board read the due sources, and only the instance's admins read every source again", async () => {
    const company = randomUUID();
    const refresh = (actor: Express.Request["actor"], body: object) => request(appWith({}, actor)).post("/api/free-models/moan/refresh").send(body);
    expect((await refresh({ type: "agent", source: "agent_key", agentId: randomUUID(), companyId: company }, {})).status).toBe(403);
    expect((await refresh(member(company, "viewer"), { force: true })).status).toBe(403);
    expect((await refresh(member(company), { force: true })).status).toBe(403);
    expect(moan.refresh).not.toHaveBeenCalled();

    const due = await refresh(member(company), {});
    expect(due.status).toBe(200);
    expect(due.body).toEqual({ started: true, sources: 3, status: { pages: 120 } });
    expect(moan.refresh).toHaveBeenLastCalledWith({ force: false });
    expect((await refresh(member(company, "owner", { isInstanceAdmin: true }), { force: true })).status).toBe(200);
    expect(moan.refresh).toHaveBeenLastCalledWith({ force: true });
    expect((await refresh({ type: "board", source: "local_implicit", userId: "local-board" }, { force: true })).status).toBe(200);
    expect(moan.refresh).toHaveBeenCalledTimes(3);
  });
});

describeEmbeddedPostgres("free-model usage routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-free-models-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    // Paid list prices, per token: Studio's free usage is priced from them as each run's is.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [
        { id: "deepseek/deepseek-v4.1-flash", pricing: { prompt: "0.0000002", completion: "0.0000008" } },
        { id: "nvidia/nemotron-3-ultra-550b-a55b", pricing: { prompt: "0.0000005", completion: "0.000002" } },
      ],
    })));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const appAs = (actor: Express.Request["actor"]) => appWith(db, actor);

  async function freeRun(companyId: string, agentId: string, createdAt: Date, freeUsage?: Record<string, number | string>) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      createdAt,
      resultJson: freeUsage ? { engine: "free_models", freeUsage } : { summary: "a paid reply" },
    });
  }

  async function costEvent(companyId: string, occurredAt: Date, row: { source: string; provider: string; model: string; inputTokens: number; outputTokens: number; costCents?: number }) {
    await db.insert(costEvents).values({ companyId, occurredAt, costCents: 0, ...row });
  }

  it("sums each company's free replies and App Studio's free usage since its last reset, and only its board resets", async () => {
    const [mine, theirs] = [randomUUID(), randomUUID()];
    const [myAgent, theirAgent] = [randomUUID(), randomUUID()];
    await db.insert(companies).values([
      { id: mine, name: "Mine", issuePrefix: `F${mine.slice(0, 6)}` },
      { id: theirs, name: "Theirs", issuePrefix: `G${theirs.slice(0, 6)}` },
    ]);
    await db.insert(agents).values([
      { id: myAgent, companyId: mine, name: "Writer", role: "engineer", status: "idle", adapterType: "free_models" },
      { id: theirAgent, companyId: theirs, name: "Reader", role: "engineer", status: "idle", adapterType: "free_models" },
    ]);
    const earlier = new Date(Date.now() - 60_000);
    const model = "deepseek/deepseek-v4.1-flash:free";
    await freeRun(mine, myAgent, earlier, { model, inputTokens: 100, outputTokens: 50, images: 0, equivalentUsd: 0.25 });
    await freeRun(mine, myAgent, earlier, { model, inputTokens: 10, outputTokens: 5, images: 2, equivalentUsd: 0.5 });
    await freeRun(mine, myAgent, earlier);
    await freeRun(theirs, theirAgent, earlier, { model, inputTokens: 999, outputTokens: 999, images: 0, equivalentUsd: 9 });
    // App Studio on the free models: 0.0006 at the paid list price, and Moan at its base model's, 0.5.
    await costEvent(mine, earlier, { source: "studio", provider: "free", model, inputTokens: 1_000, outputTokens: 500 });
    await costEvent(mine, earlier, { source: "studio", provider: "free", model: MOAN_MODEL_ID, inputTokens: 1_000_000, outputTokens: 0 });
    // Not free usage from App Studio: a paid key, and agent spend.
    await costEvent(mine, earlier, { source: "studio", provider: "openai", model: "a-paid-model", inputTokens: 7_000, outputTokens: 7_000, costCents: 3 });
    await costEvent(mine, earlier, { source: "agent", provider: "free", model, inputTokens: 7_000, outputTokens: 7_000 });
    await costEvent(theirs, earlier, { source: "studio", provider: "free", model, inputTokens: 7_000, outputTokens: 7_000 });

    const board = appAs(member(mine));
    const path = `/api/companies/${mine}/free-models/usage`;
    const before = await request(board).get(path);
    expect(before.body).toMatchObject({ since: null, replies: 4, images: 2, inputTokens: 1_001_110, outputTokens: 555 });
    expect(before.body.equivalentUsd).toBeCloseTo(0.75 + 0.0006 + 0.5, 10);
    expect((await request(board).get(`/api/companies/${theirs}/free-models/usage`)).status).toBe(403);

    const agent = appAs({ type: "agent", source: "agent_key", agentId: myAgent, companyId: mine });
    expect((await request(agent).get(path)).status).toBe(200);
    expect((await request(agent).post(`${path}/reset`)).status).toBe(403);
    expect((await request(appAs(member(mine, "viewer"))).post(`${path}/reset`)).status).toBe(403);
    expect(await db.select().from(activityLog)).toHaveLength(0);

    const reset = await request(board).post(`${path}/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ replies: 0, images: 0, inputTokens: 0, outputTokens: 0, equivalentUsd: 0 });
    expect(reset.body.since).toEqual(expect.any(String));
    const [logged] = await db.select().from(activityLog).where(eq(activityLog.action, FREE_MODELS_RESET_ACTION));
    expect(logged).toMatchObject({ companyId: mine, actorType: "user", actorId: "user-owner", entityType: "company", entityId: mine });

    const later = new Date(Date.now() + 1_000);
    await freeRun(mine, myAgent, later, { model, inputTokens: 7, outputTokens: 3, images: 1, equivalentUsd: 0.125 });
    await costEvent(mine, later, { source: "studio", provider: "free", model, inputTokens: 2_000, outputTokens: 1_000 });
    const after = await request(board).get(path);
    expect(after.body).toMatchObject({ since: reset.body.since, replies: 2, images: 1, inputTokens: 2_007, outputTokens: 1_003 });
    expect(after.body.equivalentUsd).toBeCloseTo(0.125 + 0.0012, 10);
    // Another company's count is its own: this reset leaves it alone.
    const other = await request(appAs(member(theirs))).get(`/api/companies/${theirs}/free-models/usage`);
    expect(other.body).toMatchObject({ since: null, replies: 2, images: 0, inputTokens: 7_999, outputTokens: 7_999 });
  });
});
