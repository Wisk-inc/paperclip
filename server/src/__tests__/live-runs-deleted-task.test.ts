import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";

const support = await getEmbeddedPostgresTestSupport();

/**
 * The home page lists the agents' recent runs and, for each, asks for the task
 * the run worked on. A run outlives its task: deleting a chat leaves the runs
 * of its replies behind, still naming the chat. The list must not hand out the
 * id of a task that is gone (the page asked for it, got a 404 and showed "Task
 * unavailable" over a dead link), nor fill itself with such runs.
 */
(support.supported ? describe : describe.skip)("live runs whose task was deleted", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-live-runs-deleted-task-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db
      .insert(authUsers)
      .values({ id: "local-board", name: "Local Board", email: "local@paperclip.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Runs", issuePrefix: "RUN", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Nova", role: "engineer", status: "idle", adapterType: "free_models" });

    app = express();
    app.use(express.json());
    // The Automa app on a phone: the board is whoever holds the device.
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
  }, 90000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function run(input: { status: string; issueId?: string | null; minutesAgo: number }) {
    const createdAt = new Date(Date.now() - input.minutesAgo * 60_000);
    const [row] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: input.status,
        createdAt,
        startedAt: createdAt,
        finishedAt: input.status === "running" || input.status === "queued" ? null : createdAt,
        contextSnapshot: input.issueId === undefined ? {} : { issueId: input.issueId },
      })
      .returning();
    return row!.id;
  }

  it("leaves finished runs of a deleted task out of the padding and reports a live one without a task", async () => {
    const [kept] = await db.insert(issues).values({ companyId, title: "Write the launch post", status: "todo" }).returning();
    const [doomed] = await db.insert(issues).values({ companyId, title: "A chat to delete", status: "todo" }).returning();

    const finishedOnKeptTask = await run({ status: "succeeded", issueId: kept!.id, minutesAgo: 5 });
    const finishedOnDeletedTask = await run({ status: "succeeded", issueId: doomed!.id, minutesAgo: 4 });
    const scheduledHeartbeat = await run({ status: "succeeded", minutesAgo: 3 });
    const oddContext = await run({ status: "failed", issueId: "not-a-task-id", minutesAgo: 2 });
    const liveOnDeletedTask = await run({ status: "running", issueId: doomed!.id, minutesAgo: 1 });
    const liveOnKeptTask = await run({ status: "running", issueId: kept!.id, minutesAgo: 0 });

    await db.delete(issues).where(eq(issues.id, doomed!.id));

    const res = await request(app).get(`/api/companies/${companyId}/live-runs?minCount=6`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body as Array<{ id: string; issueId: string | null; status: string }>;
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Live runs come first and are all there; the one whose task is gone names no task.
    expect(byId.get(liveOnKeptTask)?.issueId).toBe(kept!.id);
    expect(byId.has(liveOnDeletedTask)).toBe(true);
    expect(byId.get(liveOnDeletedTask)?.issueId).toBeNull();

    // Past runs pad the list only when their task is still there, or they had none.
    expect(byId.get(finishedOnKeptTask)?.issueId).toBe(kept!.id);
    expect(byId.has(scheduledHeartbeat)).toBe(true);
    expect(byId.get(scheduledHeartbeat)?.issueId).toBeNull();
    expect(byId.has(finishedOnDeletedTask)).toBe(false);
    // An id that is not a task id at all cannot fail the query; the run is treated the same way.
    expect(byId.has(oddContext)).toBe(false);

    // Nothing the list names answers "not found".
    const named = rows.map((row) => row.issueId).filter((id): id is string => Boolean(id));
    expect(new Set(named)).toEqual(new Set([kept!.id]));
  });

  it("does not hand out a task of another organization", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Elsewhere", issuePrefix: "ELS", requireBoardApprovalForNewAgents: false });
    const [foreign] = await db.insert(issues).values({ companyId: otherCompanyId, title: "Not ours", status: "todo" }).returning();
    const runId = await run({ status: "running", issueId: foreign!.id, minutesAgo: 0 });

    const res = await request(app).get(`/api/companies/${companyId}/live-runs`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = (res.body as Array<{ id: string; issueId: string | null }>).find((entry) => entry.id === runId);
    expect(row).toBeDefined();
    expect(row!.issueId).toBeNull();
  });
});
