import { and, desc, eq, gt, sql } from "drizzle-orm";
import { activityLog, costEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { MOAN_LABEL, MOAN_MODEL_ID, resolveFreeModel, type FreeModelCheckResult, type FreeModelUsageSummary } from "@paperclipai/shared";
import type { ModelCatalogSnapshot } from "@paperclipai/shared/model-catalog";
import {
  freeModelHealth,
  PUTER_IMAGE_MODEL_META,
  PUTER_IMAGE_MODELS,
  PUTER_MODEL_LIST,
  PUTER_MODEL_META,
  PUTER_MODELS,
  PuterHttpError,
  puterStream,
  type PuterImageModelKey,
  type PuterMessage,
  type PuterModelKey,
  type PuterUsage,
} from "@paperclipai/shared/puter-ai";
import { getModelCatalog } from "./model-catalog.js";

export const FREE_MODELS_RESET_ACTION = "free_models.usage_reset";

// ── Which free models answer right now ───────────────────────────────────
// A provider can take a free version offline for a day or a month, and Automa
// never answers on a different model than the one picked. Asking every model
// for one word tells the pickers which ones to mark, so nobody has to find a
// model that answers by trying them one at a time.

const CHECK_MESSAGES: PuterMessage[] = [
  { role: "system", content: "You are a connectivity check. Reply with exactly the word OK." },
  { role: "user", content: "Reply with OK." },
];
/** How long one model gets to say its one word. */
const CHECK_TIMEOUT_MS = 45_000;
/** A check asked for again sooner than this gets the answer of the last one. */
const CHECK_GAP_MS = 60_000;
/** Models asked at the same time: few, so the check never trips the service's own rate limit. */
const CHECK_AT_ONCE = 2;

export type FreeModelProbe = "answered" | "refused" | "unreachable";

/** No model could be reached at all: the phone or computer is offline, or the service is. */
export class FreeModelsUnreachableError extends Error {
  constructor() {
    super("Can't reach the free models right now. Check the connection and try again.");
  }
}

/**
 * One word from one model. What the model answered, or how it refused, is
 * noted by the engine itself (freeModelHealth); only "no answer of any kind"
 * is told apart here.
 */
async function askFreeModelForOneWord(model: string): Promise<FreeModelProbe> {
  try {
    for await (const _event of puterStream(CHECK_MESSAGES, { model, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })) {
      // Only whether it answers matters.
    }
    return "answered";
  } catch (error) {
    return error instanceof PuterHttpError ? "refused" : "unreachable";
  }
}

let checkInFlight: Promise<FreeModelCheckResult> | null = null;
let lastCheck: { at: number; result: FreeModelCheckResult } | null = null;

export interface FreeModelCheckOptions {
  models?: readonly string[];
  ask?: (model: string) => Promise<FreeModelProbe>;
  now?: () => number;
}

/**
 * Asks every free chat model for one word, two at a time, and returns each
 * one's state. Two people tapping at once share one check, and a check asked
 * for within a minute of the last gets that one's result.
 */
export function checkFreeModels(options: FreeModelCheckOptions = {}): Promise<FreeModelCheckResult> {
  const now = options.now ?? Date.now;
  if (checkInFlight) return checkInFlight;
  if (lastCheck && now() - lastCheck.at < CHECK_GAP_MS) return Promise.resolve(lastCheck.result);
  const models = [...(options.models ?? PUTER_MODEL_LIST)];
  const ask = options.ask ?? askFreeModelForOneWord;
  checkInFlight = (async () => {
    const found = new Map<string, FreeModelProbe>();
    const waiting = [...models];
    const worker = async () => {
      for (let model = waiting.shift(); model !== undefined; model = waiting.shift()) {
        found.set(model, await ask(model).catch((): FreeModelProbe => "unreachable"));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_AT_ONCE, models.length) }, worker));
    if (models.length > 0 && [...found.values()].every((probe) => probe === "unreachable")) throw new FreeModelsUnreachableError();
    const health = freeModelHealth();
    const result: FreeModelCheckResult = {
      checkedAt: new Date(now()).toISOString(),
      total: models.length,
      answering: models.filter((model) => found.get(model) === "answered").length,
      health: Object.fromEntries(models.flatMap((model) => (health[model] ? [[model, health[model]]] : []))),
    };
    lastCheck = { at: now(), result };
    return result;
  })().finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

/** Forgets the last check (tests). */
export function resetFreeModelCheckForTests(): void {
  checkInFlight = null;
  lastCheck = null;
}

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

let priceCache: { catalog: ModelCatalogSnapshot; prices: Map<string, Price> } | undefined;

/**
 * Paid list prices (USD per token) from the model catalog (services/model-catalog.ts:
 * the public catalog, kept up to date in the background; no credentials involved).
 */
function paidPrices(): Map<string, Price> {
  const catalog = getModelCatalog();
  if (priceCache?.catalog !== catalog) {
    const prices = new Map<string, Price>();
    for (const model of catalog.models) if (model.price) prices.set(model.id, model.price);
    priceCache = { catalog, prices };
  }
  return priceCache.prices;
}

/** What `usage` on `model` would cost at the paid version's list price. */
export async function equivalentTokenCostUsd(model: string, usage: PuterUsage): Promise<number> {
  return equivalentTokenCostUsdNow(model, usage);
}

/** Loads the prices (and starts a catalog download when the one it has is old). */
export function warmPaidPrices(): void {
  paidPrices();
}

/**
 * The same as equivalentTokenCostUsd, for live counters. A model with no paid
 * listing is priced at a typical small open-model rate.
 */
export function equivalentTokenCostUsdNow(model: string, usage: PuterUsage): number {
  const price = paidPrices().get(model.replace(/:free$/, "")) ?? FALLBACK_PRICE;
  return usage.inputTokens * price.input + usage.outputTokens * price.output;
}

export function equivalentImageCostUsd(images: number): number {
  return images * IMAGE_REFERENCE_USD;
}

/**
 * Free usage since the last reset: agent replies (each run records its own),
 * and App Studio's assistant and code suggestions, which record their tokens
 * as $0 cost events and are priced here the same way, per model.
 */
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
      // A run records its free usage when it finishes: counted by that, a reply
      // still running at the reset counts after it instead of nowhere.
      since ? sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) > ${since.toISOString()}::timestamptz` : undefined,
    ));
  const studio = await db
    .select({
      model: costEvents.model,
      replies: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens} + ${costEvents.cachedInputTokens}), 0)::float8`,
      outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::float8`,
    })
    .from(costEvents)
    .where(and(
      eq(costEvents.companyId, companyId),
      eq(costEvents.source, "studio"),
      eq(costEvents.provider, "free"),
      since ? gt(costEvents.occurredAt, since) : undefined,
    ))
    .groupBy(costEvents.model);
  const studioUsd = await Promise.all(studio.map((part) => {
    const spent = { inputTokens: Number(part.inputTokens), outputTokens: Number(part.outputTokens) };
    return spent.inputTokens + spent.outputTokens > 0 ? equivalentTokenCostUsd(resolveFreeModel(part.model).puterModel, spent) : 0;
  }));
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    since: since ? since.toISOString() : null,
    replies: Number(row?.replies ?? 0) + sum(studio.map((part) => Number(part.replies))),
    images: Number(row?.images ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0) + sum(studio.map((part) => Number(part.inputTokens))),
    outputTokens: Number(row?.outputTokens ?? 0) + sum(studio.map((part) => Number(part.outputTokens))),
    equivalentUsd: Number(row?.equivalentUsd ?? 0) + sum(studioUsd),
  };
}
