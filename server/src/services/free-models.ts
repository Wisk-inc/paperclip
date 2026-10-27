import { and, desc, eq, gt, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { MOAN_LABEL, MOAN_MODEL_ID, type FreeModelUsageSummary } from "@paperclipai/shared";
import {
  PUTER_IMAGE_MODEL_META,
  PUTER_IMAGE_MODELS,
  PUTER_MODEL_META,
  PUTER_MODELS,
  type PuterImageModelKey,
  type PuterModelKey,
  type PuterUsage,
} from "@paperclipai/shared/puter-ai";

export const FREE_MODELS_RESET_ACTION = "free_models.usage_reset";

/** Moan first, then the chat models, then the image models that work without an input image. */
export function listFreeModels(): AdapterModel[] {
  const chat: AdapterModel[] = [
    { id: MOAN_MODEL_ID, label: MOAN_LABEL },
    ...(Object.entries(PUTER_MODELS) as [PuterModelKey, string][]).map(([key, id]) => ({
      id,
      label: PUTER_MODEL_META[key].label,
    })),
  ];
  const image = (Object.entries(PUTER_IMAGE_MODELS) as [PuterImageModelKey, string][])
    .filter(([key]) => !PUTER_IMAGE_MODEL_META[key].needsInputImage)
    .map(([key, id]) => ({ id, label: `${PUTER_IMAGE_MODEL_META[key].label} · image` }));
  return [...chat, ...image];
}

type Price = { input: number; output: number };
// Used when a model has no paid listing: a typical small open-model rate.
const FALLBACK_PRICE: Price = { input: 0.1 / 1e6, output: 0.4 / 1e6 };
// Hosted SDXL-class generation commonly lists around $0.002 per image.
const IMAGE_REFERENCE_USD = 0.002;

let priceCache: { until: number; prices: Map<string, Price> } | undefined;
let pricePending: Promise<Map<string, Price>> | undefined;

/** Paid list prices (USD per token) from OpenRouter's public catalog; no credentials involved. */
async function paidPrices(): Promise<Map<string, Price>> {
  if (priceCache && priceCache.until > Date.now()) return priceCache.prices;
  pricePending ??= (async () => {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`catalog answered ${response.status}`);
      const body = await response.json() as { data?: Array<{ id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }> };
      const prices = new Map<string, Price>();
      for (const model of body.data ?? []) {
        if (typeof model.id !== "string") continue;
        const input = Number(model.pricing?.prompt);
        const output = Number(model.pricing?.completion);
        if (Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0)) prices.set(model.id, { input, output });
      }
      priceCache = { until: Date.now() + 6 * 60 * 60_000, prices };
    } catch {
      // Offline or blocked: keep any earlier prices and fall back for the rest; retry in ten minutes.
      priceCache = { until: Date.now() + 10 * 60_000, prices: priceCache?.prices ?? new Map() };
    }
    return priceCache.prices;
  })().finally(() => {
    pricePending = undefined;
  });
  return pricePending;
}

/** What `usage` on `model` would cost at the paid version's list price. */
export async function equivalentTokenCostUsd(model: string, usage: PuterUsage): Promise<number> {
  const price = (await paidPrices()).get(model.replace(/:free$/, "")) ?? FALLBACK_PRICE;
  return usage.inputTokens * price.input + usage.outputTokens * price.output;
}

export function equivalentImageCostUsd(images: number): number {
  return images * IMAGE_REFERENCE_USD;
}

export async function freeModelUsage(db: Db, companyId: string): Promise<FreeModelUsageSummary> {
  const since = await db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, FREE_MODELS_RESET_ACTION)))
    .orderBy(desc(activityLog.createdAt))
    .limit(1)
    .then((rows) => rows[0]?.createdAt ?? null);
  const usage = sql`${heartbeatRuns.resultJson} -> 'freeUsage'`;
  const total = (field: string) => sql<number>`coalesce(sum((${usage} ->> ${field})::numeric), 0)::float8`;
  const [row] = await db
    .select({
      replies: sql<number>`count(*)::int`,
      images: total("images"),
      inputTokens: total("inputTokens"),
      outputTokens: total("outputTokens"),
      equivalentUsd: total("equivalentUsd"),
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      sql`${usage} is not null`,
      since ? gt(heartbeatRuns.createdAt, since) : undefined,
    ));
  return {
    since: since ? since.toISOString() : null,
    replies: Number(row?.replies ?? 0),
    images: Number(row?.images ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    equivalentUsd: Number(row?.equivalentUsd ?? 0),
  };
}
