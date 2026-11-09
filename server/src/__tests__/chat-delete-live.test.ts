import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  adapterExecutionControls,
  createAdapterExecutionControl,
  registerAdapterExecutionControl,
} from "../services/adapter-execution-control.js";

const support = await getEmbeddedPostgresTestSupport();

/**
 * Deleting a chat while the AI is still writing its reply, from the Automa
 * app (the phone's own board, local_trusted). The reply's run is stopped
 * first, then the chat goes; neither a slow stream nor an engine that cannot
 * be stopped by signal keeps the chat from being deleted.
 */
(support.supported ? describe : describe.skip)("deleting a chat while the AI is replying", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let app: express.Express;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-chat-delete-live-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db
      .insert(authUsers)
      .values({ id: "local-board", name: "Local Board", email: "local@paperclip.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Chats", issuePrefix: "CHAT", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Atlas", role: "engineer", status: "running", adapterType: "free_models" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });

    app = express();
    app.use(express.json());
    // The Automa app on a phone: the board is whoever holds the device.
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, { deleteObject: async () => undefined } as never));
    app.use(errorHandler);
  }, 90000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  afterEach(() => {
    adapterExecutionControls.clear();
  });

  /** A chat whose reply is being written: its run is running and bound to the chat. */
  async function liveChat() {
    const opened = await request(app).post(`/api/companies/${companyId}/chats/${agentId}`).send({});
    expect(opened.status).toBe(200);
    const chat = opened.body as { id: string };
    const [message] = await db
      .insert(issueComments)
      .values({ companyId, issueId: chat.id, authorType: "user", authorUserId: "local-board", body: "Tell me a long story" })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { issueId: chat.id, taskKey: chat.id, wakeCommentId: message!.id, commentId: message!.id },
      })
      .returning();
    await db.update(issues).set({ executionRunId: run!.id, conversationState: "active" }).where(eq(issues.id, chat.id));
    return { chat, run: run! };
  }

  it("stops the reply the engine is streaming, then deletes the chat", async () => {
    const { chat, run } = await liveChat();
    // The engine opted into Stop (as the free-models engine does): once its
    // stream is aborted it ends like the executor does, acknowledging the stop.
    const control = createAdapterExecutionControl();
    const stopReason = new Promise<string>((resolve) => {
      control.controller.signal.addEventListener("abort", () => {
        void db
          .update(heartbeatRuns)
          .set({
            status: "cancelled",
            finishedAt: new Date(),
            resultJson: { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } },
          })
          .where(eq(heartbeatRuns.id, run.id))
          .then(() => {
            control.finish();
            resolve((control.controller.signal.reason as Error).message);
          });
      });
    });
    await registerAdapterExecutionControl(run.id, control);

    const res = await request(app).delete(`/api/issues/${chat.id}`);
    expect(res.status).toBe(200);
    expect(await stopReason).toBe("Cancelled because the task was deleted");
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.id, chat.id))).toEqual([]);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(after?.status).toBe("cancelled");
  });

  it("still deletes the chat when the engine cannot be stopped by signal", async () => {
    const { chat, run } = await liveChat();

    const res = await request(app).delete(`/api/issues/${chat.id}`);
    expect(res.status).toBe(200);
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.id, chat.id))).toEqual([]);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(after?.status).toBe("cancelled");
    expect(after?.errorCode).toBe("issue_deleted");
  });

  it("does not wait longer than the stop allowance for a reply slow to stop", async () => {
    const { chat, run } = await liveChat();
    // The engine took the stop but is held up in a tool call: it settles only
    // once the delete has gone through.
    const control = createAdapterExecutionControl();
    await registerAdapterExecutionControl(run.id, control);
    process.env.PAPERCLIP_ISSUE_DELETE_STOP_WAIT_MS = "500";
    try {
      const startedAt = Date.now();
      const res = await request(app).delete(`/api/issues/${chat.id}`);
      expect(res.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(control.controller.signal.aborted).toBe(true);
      expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.id, chat.id))).toEqual([]);
    } finally {
      delete process.env.PAPERCLIP_ISSUE_DELETE_STOP_WAIT_MS;
      // The engine ends as the executor would; the stop that kept running settles.
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: new Date(), resultJson: { executionCancellation: { state: "acknowledged" } } })
        .where(eq(heartbeatRuns.id, run.id));
      control.finish();
    }
  });

  it("cancels the retries and queued follow-ups still waiting for a deleted chat", async () => {
    const opened = await request(app).post(`/api/companies/${companyId}/chats/${agentId}`).send({});
    expect(opened.status).toBe(200);
    const chat = opened.body as { id: string };
    // The reply failed on a busy model and a retry waits for later (hours away
    // when a model's daily limit has to reset); another message is queued behind it.
    const waiting = await db
      .insert(heartbeatRuns)
      .values([
        { companyId, agentId, status: "failed", startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId: chat.id } },
        { companyId, agentId, status: "scheduled_retry", scheduledRetryAt: new Date(Date.now() + 6 * 60 * 60_000), scheduledRetryAttempt: 1, contextSnapshot: { issueId: chat.id } },
        { companyId, agentId, status: "queued", contextSnapshot: { issueId: chat.id } },
      ])
      .returning();
    // A retry waiting for another chat is none of this delete's business.
    const [elsewhere] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "scheduled_retry", scheduledRetryAt: new Date(Date.now() + 60_000), scheduledRetryAttempt: 1, contextSnapshot: { issueId: randomUUID() } })
      .returning();

    const res = await request(app).delete(`/api/issues/${chat.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.id, chat.id))).toEqual([]);

    const after = new Map((await db.select().from(heartbeatRuns)).map((run) => [run.id, run]));
    expect(after.get(waiting[0]!.id)?.status).toBe("failed");
    for (const run of waiting.slice(1)) {
      expect(after.get(run.id)?.status).toBe("cancelled");
      expect(after.get(run.id)?.errorCode).toBe("issue_deleted");
    }
    // Nothing of the deleted chat keeps the agent "still working", so it can be removed.
    const stillWaiting = [...after.values()].filter((run) =>
      ["queued", "running", "scheduled_retry"].includes(run.status) && (run.contextSnapshot as { issueId?: string } | null)?.issueId === chat.id);
    expect(stillWaiting).toEqual([]);
    expect(after.get(elsewhere!.id)?.status).toBe("scheduled_retry");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, elsewhere!.id));
  });

  it("deletes a chat that is only waiting for its reply to start", async () => {
    const opened = await request(app).post(`/api/companies/${companyId}/chats/${agentId}`).send({});
    const chat = opened.body as { id: string };
    const res = await request(app).delete(`/api/issues/${chat.id}`);
    expect(res.status).toBe(200);
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.id, chat.id))).toEqual([]);
  });
});
