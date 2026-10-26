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

/** The chat model a first agent hired with "Skip for now" starts on: fast, smart, and free. */
export const DEFAULT_FREE_CHAT_MODEL = "deepseek/deepseek-v4.1-flash:free";

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
