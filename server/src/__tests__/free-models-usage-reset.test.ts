import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { FREE_MODELS_RESET_ACTION, freeModelUsage } from "../services/free-models.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("free usage since the last reset", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-free-usage-reset-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("counts a reply by when it finished, so one running at the reset counts after it", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Shop", issuePrefix: `F${companyId.slice(0, 5).toUpperCase()}` });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Ada" });
    const reset = new Date("2026-11-01T12:00:00.000Z");
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "owner",
      action: FREE_MODELS_RESET_ACTION,
      entityType: "company",
      entityId: companyId,
      createdAt: reset,
    });
    const run = (createdAt: string, finishedAt: string, inputTokens: number) => ({
      companyId,
      agentId,
      status: "succeeded",
      createdAt: new Date(createdAt),
      finishedAt: new Date(finishedAt),
      resultJson: { freeUsage: { inputTokens, outputTokens: 0, images: 0, equivalentUsd: 0 } },
    });
    await db.insert(heartbeatRuns).values([
      // Started and finished before the reset: belongs to the old count.
      run("2026-11-01T11:00:00.000Z", "2026-11-01T11:05:00.000Z", 1),
      // Started before the reset, finished after it: its usage was recorded after the reset.
      run("2026-11-01T11:59:00.000Z", "2026-11-01T12:03:00.000Z", 10),
      // Wholly after the reset.
      run("2026-11-01T12:10:00.000Z", "2026-11-01T12:11:00.000Z", 100),
    ]);

    const usage = await freeModelUsage(db, companyId);
    expect(usage.since).toBe(reset.toISOString());
    expect(usage.replies).toBe(2);
    expect(usage.inputTokens).toBe(110);
  });
});
