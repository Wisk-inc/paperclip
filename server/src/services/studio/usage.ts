import type { Db } from "@paperclipai/db";
import { costService } from "../costs.js";
import { logger } from "../../middleware/logger.js";
import type { StudioAiUsage } from "./assistant.js";

/**
 * App Studio's AI spend goes into Costs like an agent's, marked as App Studio
 * (no agent). The assistant records one event per reply; code suggestions are
 * many tiny calls, so they are added up per organization and model and
 * recorded once they reach a cent (or after a while), keeping the fraction of
 * a cent for the next batch instead of rounding it away.
 */
const FLUSH_AFTER_MS = 5 * 60_000;

interface Pending {
  companyId: string;
  usage: StudioAiUsage;
  /** US dollars not yet recorded (below one cent). */
  costUsd: number;
  startedAt: number;
}

export function studioUsageRecorder(db: Db) {
  const costs = costService(db);
  const pending = new Map<string, Pending>();

  async function write(companyId: string, usage: StudioAiUsage, costCents: number) {
    if (!usage.inputTokens && !usage.cachedInputTokens && !usage.outputTokens && costCents === 0) return;
    await costs.createEvent(companyId, {
      agentId: null,
      source: "studio",
      provider: usage.provider,
      biller: usage.provider,
      billingType: "api",
      costStatus: usage.costUsd === null ? "unpriced" : "reported",
      model: usage.model,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      costCents,
      occurredAt: new Date(),
    });
  }

  return {
    /** One assistant reply. */
    async recordReply(companyId: string, usage: StudioAiUsage) {
      await write(companyId, usage, Math.max(0, Math.round((usage.costUsd ?? 0) * 100)));
    },

    /** One code suggestion; recorded in batches. */
    recordSuggestion(companyId: string, usage: StudioAiUsage) {
      const key = `${companyId}:${usage.provider}:${usage.model}`;
      const entry = pending.get(key) ?? {
        companyId,
        usage: { ...usage, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 },
        costUsd: 0,
        startedAt: Date.now(),
      };
      entry.usage.inputTokens += usage.inputTokens;
      entry.usage.cachedInputTokens += usage.cachedInputTokens;
      entry.usage.outputTokens += usage.outputTokens;
      if (usage.costUsd === null) entry.usage.costUsd = null;
      entry.costUsd += usage.costUsd ?? 0;
      pending.set(key, entry);
      const cents = Math.floor(entry.costUsd * 100);
      if (cents < 1 && Date.now() - entry.startedAt < FLUSH_AFTER_MS) return;
      pending.delete(key);
      const remainder = entry.costUsd - cents / 100;
      void write(companyId, entry.usage, cents)
        .then(() => {
          if (remainder > 0) {
            // The leftover fraction of a cent starts the next batch.
            this.recordSuggestion(companyId, { ...usage, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: remainder });
          }
        })
        .catch((error) => logger.warn({ error: error instanceof Error ? error.message : String(error) }, "studio suggestion usage not recorded"));
    },
  };
}
