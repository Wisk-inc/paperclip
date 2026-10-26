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
