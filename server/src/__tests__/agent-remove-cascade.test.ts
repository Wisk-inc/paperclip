import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  chatEndpoints,
  companies,
  costEvents,
  createDb,
  decisionBundles,
  decisionQueues,
  decisions,
  financeEvents,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
  routines,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// These tests protect DELETE /api/agents/:id. Once an agent had run, its cost
// events, decisions and queue attributions still pointed at its heartbeat runs,
// so the delete transaction raised SQLSTATE 23503 and the route answered with a
// bare 500. The delete now detaches or removes every dependent row, and the two
// cases that must not be torn down silently (an active run, an assigned chat
// endpoint) answer with a typed 409.
describeEmbeddedPostgres("agentService.remove referential integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-cascade-");
    db = createDb(tempDb.connectionString);
    svc = agentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(chatEndpoints);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(decisionQueues);
    await db.delete(decisions);
    await db.delete(decisionBundles);
    await db.delete(activityLog);
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentApiKeys);
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(runStatus: "succeeded" | "running" = "succeeded") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Automa",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Probe",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: runStatus,
    });

    return { companyId, agentId, runId };
  }

  it("deletes an agent together with its run history and detaches what it owned", async () => {
    const { companyId, agentId, runId } = await seedCompanyAndAgent();

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Worked by the probe",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "run.started",
    });
    const costEventId = randomUUID();
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      issueId,
      heartbeatRunId: runId,
      provider: "anthropic",
      model: "claude-opus-5-5",
      costCents: 42,
      occurredAt: new Date(),
    });
    const financeEventId = randomUUID();
    await db.insert(financeEvents).values({
      id: financeEventId,
      companyId,
      agentId,
      issueId,
      heartbeatRunId: runId,
      costEventId,
      eventKind: "usage",
      biller: "anthropic",
      amountCents: 42,
      occurredAt: new Date(),
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
    });
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({
      id: keyId,
      agentId,
      companyId,
      name: "probe key",
      keyHash: "hash",
    });
    const bundleId = randomUUID();
    await db.insert(decisionBundles).values({
      id: bundleId,
      companyId,
      title: "Bundle",
      summary: "Decisions raised by the probe",
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: runId,
    });
    const decisionId = randomUUID();
    await db.insert(decisions).values({
      id: decisionId,
      companyId,
      bundleId,
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: runId,
      title: "Ship it?",
      body: "Raised during the run.",
      options: [],
      expiresAt: new Date(Date.now() + 60_000),
      signedSpec: "signed",
      targetSnapshots: {},
    });
    const queueId = randomUUID();
    await db.insert(decisionQueues).values({
      id: queueId,
      companyId,
      key: "probe-queue",
      title: "Probe queue",
      createdByType: "agent",
      createdByAgentId: agentId,
      createdByRunId: runId,
      createdByAgentApiKeyId: keyId,
    });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Led by the probe",
      status: "active",
      leadAgentId: agentId,
    });
    const goalId = randomUUID();
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Owned by the probe",
      level: "task",
      status: "active",
      ownerAgentId: agentId,
    });
    const routineId = randomUUID();
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Nightly probe",
      status: "active",
      assigneeAgentId: agentId,
    });

    const removed = await svc.remove(agentId);
    expect(removed?.id).toBe(agentId);

    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toHaveLength(0);
    expect(await db.select().from(costEvents).where(eq(costEvents.id, costEventId))).toHaveLength(0);
    expect(await db.select().from(decisions).where(eq(decisions.id, decisionId))).toHaveLength(0);
    expect(await db.select().from(decisionBundles).where(eq(decisionBundles.id, bundleId))).toHaveLength(0);
    expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, keyId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.runId, runId))).toHaveLength(0);

    // Money already spent stays on the ledger, without the agent attribution.
    const financeRows = await db.select().from(financeEvents).where(eq(financeEvents.id, financeEventId));
    expect(financeRows).toHaveLength(1);
    expect(financeRows[0]?.agentId).toBeNull();
    expect(financeRows[0]?.heartbeatRunId).toBeNull();
    expect(financeRows[0]?.costEventId).toBeNull();

    const issueRows = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueRows).toHaveLength(1);
    expect(issueRows[0]?.assigneeAgentId).toBeNull();
    expect(issueRows[0]?.checkoutRunId).toBeNull();

    const queueRows = await db.select().from(decisionQueues).where(eq(decisionQueues.id, queueId));
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0]?.createdByType).toBe("system");
    expect(queueRows[0]?.createdByAgentId).toBeNull();
    expect(queueRows[0]?.createdByRunId).toBeNull();
    expect(queueRows[0]?.createdByAgentApiKeyId).toBeNull();

    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]?.leadAgentId).toBeNull();
    expect((await db.select().from(goals).where(eq(goals.id, goalId)))[0]?.ownerAgentId).toBeNull();

    const routineRows = await db.select().from(routines).where(eq(routines.id, routineId));
    expect(routineRows[0]?.assigneeAgentId).toBeNull();
    expect(routineRows[0]?.status).toBe("paused");
  });

  it("refuses with a 409 while the agent still has an active run", async () => {
    const { agentId } = await seedCompanyAndAgent("running");

    await expect(svc.remove(agentId)).rejects.toBeInstanceOf(HttpError);
    await expect(svc.remove(agentId)).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_has_active_runs" },
    });
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(1);
  });

  it("refuses with a 409 while a chat endpoint is assigned to the agent", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `chat:discord:${endpointId}`,
      name: "Discord",
      type: "chat",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      uid: endpointId,
      name: "Discord",
      connectionPurpose: "channel",
      transport: "chat_sdk",
      status: "active",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider: "discord",
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
    });

    await expect(svc.remove(agentId)).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_assigned_to_chat_endpoint" },
    });
    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(1);
  });
});
