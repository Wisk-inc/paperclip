import type { AdapterModel } from "@paperclipai/adapter-utils";
import { PUTER_MODELS, PUTER_MODEL_META, type PuterModelKey } from "@paperclipai/shared";

/**
 * Returns the full Puter free-model catalog as AdapterModel entries.
 * These models cost $0 forever and require only PUTER_AUTH_TOKEN.
 */
export function listPuterModels(): AdapterModel[] {
  return (Object.entries(PUTER_MODELS) as [PuterModelKey, string][]).map(([key, id]) => {
    const meta = PUTER_MODEL_META[key];
    const tags = meta.tags.length ? ` (${meta.tags.join(", ")})` : "";
    return {
      id: `puter/${id}`,
      label: `[Free] ${key}${tags}`,
    };
  });
}

/** True when the env has a Puter auth token configured. */
export function isPuterConfigured(): boolean {
  return Boolean(process.env.PUTER_AUTH_TOKEN);
}
