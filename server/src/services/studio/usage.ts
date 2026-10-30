import { and, eq, gte, sql } from "drizzle-orm";
import { costEvents, type Db } from "@paperclipai/db";
import { resolveFreeModel, type StudioUsageSummary } from "@paperclipai/shared";
import { costService } from "../costs.js";
import { equivalentTokenCostUsd } from "../free-models.js";
import type { BudgetServiceHooks } from "../budgets.js";
import { logger } from "../../middleware/logger.js";
import type { StudioAiUsage } from "./assistant.js";

/**
 * App Studio's AI spend goes into Costs like an agent's, marked as App Studio
 * (no agent). The assistant records one event per reply; code suggestions are
 * many tiny calls, so they are added up per organization and model and
 * recorded once they reach a cent, after a while, or when the server stops.
 * Each event carries its exact cost, and the ledger keeps the month's cents
 * right, so fractions of a cent are never rounded away.
 */
const FLUSH_AFTER_MS = 5 * 60_000;

interface Pending {
  companyId: string;
  usage: StudioAiUsage;
  /** Writes the batch after a while even if no other suggestion comes. */
  timer: NodeJS.Timeout | null;
}

/** Every recorder's pending batches, written when the server shuts down. */
const shutdownFlushes = new Set<() => Promise<void>>();

export async function flushStudioUsageForShutdown() {
  await Promise.all([...shutdownFlushes].map((flush) => flush()));
}

/** What each provider and model did for App Studio since a time, most tokens first. */
export async function studioModelUsage(db: Db, companyId: string, since: Date): Promise<StudioUsageSummary> {
  const rows = await db
    .select({
      provider: costEvents.provider,
      model: costEvents.model,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens} + ${costEvents.cachedInputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::float8`,
      costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::float8`,
    })
    .from(costEvents)
    .where(and(eq(costEvents.companyId, companyId), eq(costEvents.source, "studio"), gte(costEvents.occurredAt, since)))
    .groupBy(costEvents.provider, costEvents.model);
  const models = (
    await Promise.all(
      rows.map(async (row) => {
        const inputTokens = Number(row.inputTokens);
        const outputTokens = Number(row.outputTokens);
        const costCents = Number(row.costCents);
        // Free models cost nothing; this is what the same tokens cost on the paid version.
        const equivalentCents =
          row.provider === "free" && inputTokens + outputTokens > 0
            ? (await equivalentTokenCostUsd(resolveFreeModel(row.model).puterModel, { inputTokens, outputTokens })) * 100
            : costCents;
        return { provider: row.provider, model: row.model, calls: Number(row.calls), inputTokens, outputTokens, costCents, equivalentCents };
      }),
    )
  ).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  return { since: since.toISOString(), models };
}

export function studioUsageRecorder(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const costs = costService(db, budgetHooks);
  const pending = new Map<string, Pending>();

  async function write(companyId: string, usage: StudioAiUsage) {
    const costUsd = usage.costUsd ?? 0;
    if (!usage.inputTokens && !usage.cachedInputTokens && !usage.outputTokens && costUsd <= 0) return;
    await costs.createEvent(companyId, {
      agentId: null,
      source: "studio",
      provider: usage.provider,
      biller: usage.provider,
      billingType: "metered_api",
      costStatus: usage.costUsd === null ? "unpriced" : "reported",
      model: usage.model,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      costCents: Math.max(0, Math.round(costUsd * 100)),
      costMicros: usage.costUsd === null ? null : Math.max(0, Math.round(costUsd * 1_000_000)),
      occurredAt: new Date(),
    });
  }

  function writeBatch(key: string, entry: Pending) {
    if (pending.get(key) !== entry) return Promise.resolve();
    pending.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    return write(entry.companyId, entry.usage).catch((error) =>
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, "studio suggestion usage not recorded"),
    );
  }

  shutdownFlushes.add(async () => {
    await Promise.all([...pending.entries()].map(([key, entry]) => writeBatch(key, entry)));
  });

  return {
    /** One assistant reply. */
    async recordReply(companyId: string, usage: StudioAiUsage) {
      await write(companyId, usage);
    },

    /** One code suggestion; recorded in batches. */
    recordSuggestion(companyId: string, usage: StudioAiUsage) {
      const key = `${companyId}:${usage.provider}:${usage.model}`;
      const existing = pending.get(key);
      const entry: Pending = existing ?? {
        companyId,
        usage: { ...usage, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 },
        timer: null,
      };
      if (!existing) {
        // Without this, the last batch (and every batch of a provider with no
        // price) waited for the next suggestion and was lost on restart.
        entry.timer = setTimeout(() => void writeBatch(key, entry), FLUSH_AFTER_MS);
        entry.timer.unref?.();
        pending.set(key, entry);
      }
      entry.usage.inputTokens += usage.inputTokens;
      entry.usage.cachedInputTokens += usage.cachedInputTokens;
      entry.usage.outputTokens += usage.outputTokens;
      if (usage.costUsd === null || entry.usage.costUsd === null) entry.usage.costUsd = null;
      else entry.usage.costUsd += usage.costUsd;
      if ((entry.usage.costUsd ?? 0) >= 0.01) void writeBatch(key, entry);
    },
  };
}
