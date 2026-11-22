// moan.ts imports nothing, so this file stays safe for the board (the service token lives in puter-ai.ts).
import { resolveFreeModel } from "./moan.js";

export const FREE_MODELS_ADAPTER_TYPE = "free_models";

/** Free-model usage since the last reset. Never billed; `equivalentUsd` is what paid list prices would have charged. */
export interface FreeModelUsageSummary {
  since: string | null;
  replies: number;
  images: number;
  inputTokens: number;
  outputTokens: number;
  equivalentUsd: number;
}

/** Shape each free run writes to `resultJson.freeUsage`. */
export interface FreeModelRunUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  images: number;
  equivalentUsd: number;
}

/**
 * The chat model a first agent hired with "Skip for now" starts on: smart,
 * free, and it takes tools. Like every free model it has a daily limit its
 * provider shares between everyone who uses it free, so on a busy day it can
 * be used up; the person is then told when it is back and to pick another.
 */
export const DEFAULT_FREE_CHAT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

/**
 * A free model's last known state: fine, at its daily limit (shared by
 * everyone who uses it free), busy at its provider, limited by its provider
 * to partner apps, taken offline, or stopped because it started charging.
 */
export type FreeModelState = "ok" | "daily_limit" | "busy" | "restricted" | "withdrawn" | "charged";

export interface FreeModelHealthEntry {
  state: FreeModelState;
  /** When the state should clear (daily limit) or is next checked; null when fine. */
  until: string | null;
  checkedAt: string;
  /**
   * What the model's last call found (1.9.15). `state` goes back to "ok" a few
   * minutes after a refusal, so the model is asked again; `last` keeps saying
   * what the answer was at `checkedAt` ("withdrawn": offline at its provider),
   * so a list can still show it hours later.
   */
  last?: FreeModelState;
}

/** `GET /free-models/health`: every model called since the server started, by model id. */
export type FreeModelHealthMap = Record<string, FreeModelHealthEntry>;

/** `POST /free-models/health/check`: every free chat model was asked for one word. */
export interface FreeModelCheckResult {
  checkedAt: string;
  /** How many models were asked. */
  total: number;
  /** How many answered. */
  answering: number;
  /** Each asked model's state, by model id. */
  health: FreeModelHealthMap;
}

/** How long a model's last finding is worth showing. */
export const FREE_MODEL_FINDING_MS = 24 * 60 * 60_000;

/**
 * Whether a free model is known not to answer: refused right now (closed by
 * its provider, limited to partner apps, paused for charging), or refused that
 * way the last time it was asked, within the last day.
 */
export function freeModelOffline(health: FreeModelHealthEntry | null | undefined, now: number = Date.now()): boolean {
  if (!health) return false;
  const closed = (state: FreeModelState | undefined) => state === "withdrawn" || state === "restricted" || state === "charged";
  if (closed(health.state) && (!health.until || new Date(health.until).getTime() > now)) return true;
  const checked = new Date(health.checkedAt).getTime();
  return closed(health.last) && Number.isFinite(checked) && now - checked >= 0 && now - checked < FREE_MODEL_FINDING_MS;
}

/** How long after a refusal a model is passed over when another one is suggested. */
export const FREE_MODEL_RECENT_REFUSAL_MS = 15 * 60_000;

/**
 * Whether a free model can be expected to answer a question sent now: it is
 * not held (at its daily limit, busy, closed by its provider), and it was not
 * refused the last time it was asked within the last quarter of an hour.
 * A model never asked since the server started counts as answering.
 */
export function freeModelAnswering(health: FreeModelHealthEntry | null | undefined, now: number = Date.now()): boolean {
  if (!health) return true;
  if (freeModelOffline(health, now)) return false;
  if (health.state !== "ok" && (!health.until || new Date(health.until).getTime() > now)) return false;
  const checked = new Date(health.checkedAt).getTime();
  const recent = Number.isFinite(checked) && now - checked >= 0 && now - checked < FREE_MODEL_RECENT_REFUSAL_MS;
  return !(recent && health.last !== undefined && health.last !== "ok");
}

/**
 * A model's health entry in a health map. Health is kept by the model that is
 * called, so a model that runs on another (Moan runs on Nemotron 3 Ultra) is
 * looked up by the one it runs on: it never has an entry of its own.
 */
function healthOf(model: string, health: FreeModelHealthMap): FreeModelHealthEntry | undefined {
  return health[resolveFreeModel(model).puterModel] ?? health[model];
}

/**
 * A model from `models` (in their order of preference) that is not known to be
 * refusing; null when every one of them is. `except` leaves a model out (the
 * one that just failed), and with it any model that runs on the same one: Moan
 * is no way past a Nemotron 3 Ultra that just refused. With `proven`, a model
 * that answered when it was last asked comes before one that has not been
 * asked yet, which is what to offer right after a refusal. Choosing is all
 * this does: nothing is switched for the person.
 */
export function pickAnsweringFreeModel(
  models: readonly string[],
  health: FreeModelHealthMap,
  options: { except?: string | null; now?: number; proven?: boolean } = {},
): string | null {
  const now = options.now ?? Date.now();
  const runsOn = (model: string) => resolveFreeModel(model).puterModel;
  const failed = options.except ? runsOn(options.except) : null;
  const open = models.filter((model) => model !== options.except && runsOn(model) !== failed && freeModelAnswering(healthOf(model, health), now));
  const proven = options.proven ? open.find((model) => healthOf(model, health)?.last === "ok") : undefined;
  return proven ?? open[0] ?? null;
}

/** The image model a free chat agent draws with until one is chosen: the fast SDXL. */
export const DEFAULT_FREE_IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
/** Stored as `imageModel` when the pairing is switched off on purpose. */
export const FREE_IMAGE_MODEL_NONE = "none";

/**
 * The image model paired with a free chat agent: the configured one, the
 * default when nothing is set (so "draw me a fox" works from the first
 * message), or none when the person turned the pairing off.
 */
export function pairedFreeImageModel(config: Record<string, unknown> | null | undefined): string {
  const raw = typeof config?.imageModel === "string" ? config.imageModel.trim() : "";
  if (raw === FREE_IMAGE_MODEL_NONE) return "";
  return raw || DEFAULT_FREE_IMAGE_MODEL;
}
