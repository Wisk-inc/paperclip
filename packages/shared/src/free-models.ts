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
 * free, takes tools, and has no shared daily limit.
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
}

/** `GET /free-models/health`: every model called since the server started, by model id. */
export type FreeModelHealthMap = Record<string, FreeModelHealthEntry>;

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
