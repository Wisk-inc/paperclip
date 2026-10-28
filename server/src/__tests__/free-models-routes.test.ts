import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { freeModelRoutes } from "../routes/free-models.js";
import { FREE_MODELS_RESET_ACTION } from "../services/free-models.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres free-model route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("free-model usage routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-free-models-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appAs(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", freeModelRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const member = (companyId: string, membershipRole = "owner"): Express.Request["actor"] => ({
    type: "board",
    source: "session",
    userId: `user-${membershipRole}`,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole, status: "active" }],
  });

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

  it("sums each company's free replies since its last reset, and only its board resets", async () => {
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

    const board = appAs(member(mine));
    const path = `/api/companies/${mine}/free-models/usage`;
    expect((await request(board).get(path)).body).toEqual({ since: null, replies: 2, images: 2, inputTokens: 110, outputTokens: 55, equivalentUsd: 0.75 });
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

    await freeRun(mine, myAgent, new Date(Date.now() + 1_000), { model, inputTokens: 7, outputTokens: 3, images: 1, equivalentUsd: 0.125 });
    expect((await request(board).get(path)).body).toEqual({ since: reset.body.since, replies: 1, images: 1, inputTokens: 7, outputTokens: 3, equivalentUsd: 0.125 });
    // Another company's count is its own: this reset leaves it alone.
    expect((await request(appAs(member(theirs))).get(`/api/companies/${theirs}/free-models/usage`)).body)
      .toEqual({ since: null, replies: 1, images: 0, inputTokens: 999, outputTokens: 999, equivalentUsd: 9 });
  });
});
