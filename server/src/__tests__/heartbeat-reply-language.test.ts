/**
 * Every agent run on a task or chat learns the language of the person it
 * answers: who wrote the waking comment, else who the task is for.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  userLanguagePreferences,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { languagePreferenceService } from "../services/language-preferences.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ADAPTER = "reply_language_test";

describeEmbeddedPostgres("the language an agent writes to a person in", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const inputs = new Map<string, AdapterExecutionContext>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-reply-language-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: ADAPTER,
      execute: async (input) => {
        inputs.set(input.runId, input);
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (const table of [
      activityLog, environmentLeases, issueComments, issues, executionWorkspaces, heartbeatRunEvents, activityLog,
      heartbeatRuns, agentWakeupRequests, agentRuntimeState, budgetPolicies, agents, environments, companySkills,
      companies, userLanguagePreferences,
    ]) {
      await db.delete(table);
    }
    inputs.clear();
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    await tempDb?.cleanup();
  });

  async function seed(person: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Lingo", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Polyglot",
      role: "engineer",
      status: "idle",
      adapterType: ADAPTER,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Write the welcome note",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: person,
      createdByUserId: person,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  async function runContext(agentId: string, context: Record<string, unknown>) {
    const run = await heartbeat.invoke(agentId, "assignment", context, "system");
    expect(run).not.toBeNull();
    const deadline = Date.now() + 15_000;
    while (!inputs.has(run!.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const input = inputs.get(run!.id);
    expect(input, "the adapter ran").toBeDefined();
    return input!.context;
  }

  it("tells the agent the language and country of the person the task is for", async () => {
    await languagePreferenceService(db).update("person-es", { language: "es", country: "MX", timeZone: "America/Mexico_City" });
    const { agentId, issueId } = await seed("person-es");
    const context = await runContext(agentId, { issueId, wakeReason: "issue_assigned" });
    expect(String(context.paperclipTaskMarkdown)).toContain("## Language");
    expect(String(context.paperclipTaskMarkdown)).toContain("uses Automa in Spanish (Español), in Mexico.");
    expect(context.paperclipReplyLanguage).toMatchObject({ language: "es", country: "MX", timeZone: "America/Mexico_City" });
  });

  it("adds nothing for a person whose language is not known", async () => {
    const { agentId, issueId } = await seed("person-unknown");
    const context = await runContext(agentId, { issueId, wakeReason: "issue_assigned" });
    expect(String(context.paperclipTaskMarkdown)).not.toContain("## Language");
    expect(context.paperclipReplyLanguage).toBeUndefined();
  });

  it("answers the person who wrote the waking comment in their language", async () => {
    await languagePreferenceService(db).update("person-es", { language: "es" });
    await languagePreferenceService(db).update("person-fr", { detectedLanguage: "fr", country: "HT" });
    const { companyId, agentId, issueId } = await seed("person-es");
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, body: "Bonjour, où en est la note ?", authorType: "user", authorUserId: "person-fr" });
    const context = await runContext(agentId, { issueId, wakeReason: "issue_commented", wakeCommentId: commentId });
    expect(String(context.paperclipTaskMarkdown)).toContain("uses Automa in French (Français), in Haiti.");
    expect(context.paperclipReplyLanguage).toMatchObject({ language: "fr", country: "HT" });
  });
});
