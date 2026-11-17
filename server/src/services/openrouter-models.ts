import type { AdapterModel } from "@paperclipai/adapter-utils";
import { getModelCatalog, refreshModelCatalog } from "./model-catalog.js";

/**
 * Every model in the public model catalog, as OpenCode names them
 * ("openrouter/<maker>/<model>"); no credentials involved. The catalog keeps
 * itself up to date (services/model-catalog.ts); `refresh` downloads it now.
 * Without a connection the list is the one the server saw last.
 */
export async function listOpenRouterModels(refresh = false): Promise<AdapterModel[]> {
  const catalog = refresh ? await refreshModelCatalog() : getModelCatalog();
  return catalog.models
    .map((model) => ({ id: `openrouter/${model.id}`, label: model.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
