import { useQuery } from "@tanstack/react-query";
import { newCatalogModels, type CatalogModel, type CatalogTarget } from "@paperclipai/shared/model-catalog";
import type { StudioAiProvider, TerminalToolId } from "@paperclipai/shared";
import { modelCatalogApi } from "@/api/modelCatalog";
import { queryKeys } from "@/lib/queryKeys";

/** The model catalog the server keeps (newest models of the major makers); fetched when a picker opens. */
export function useModelCatalog(enabled = true) {
  return useQuery({
    queryKey: queryKeys.modelCatalog(),
    queryFn: () => modelCatalogApi.get(),
    enabled,
    staleTime: 60 * 60_000,
    retry: 1,
  });
}

/** App Studio providers whose models follow the catalog, and in which id form. */
const STUDIO_TARGETS: Partial<Record<StudioAiProvider, CatalogTarget>> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  google: "google",
  moonshot: "moonshot",
  xai: "xai",
};

/** Terminal tools whose models follow the catalog. */
const TERMINAL_TARGETS: Partial<Record<TerminalToolId, CatalogTarget>> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
};

export interface ModelsWithCatalog {
  /** The catalog's newer models first (newest first), then the list as it was. */
  models: string[];
  /** The ones the catalog added. */
  added: ReadonlySet<string>;
}

function withCatalog(target: CatalogTarget | undefined, models: readonly string[], catalog: readonly CatalogModel[] | undefined): ModelsWithCatalog {
  if (!target || !catalog?.length) return { models: [...models], added: new Set() };
  const added = newCatalogModels(target, models, catalog);
  return { models: [...added.map((model) => model.id), ...models], added: new Set(added.map((model) => model.id)) };
}

/** An App Studio provider's models with the catalog's newer ones in front. */
export function studioModelsWithCatalog(provider: StudioAiProvider, models: readonly string[], catalog: readonly CatalogModel[] | undefined): ModelsWithCatalog {
  return withCatalog(STUDIO_TARGETS[provider], models, catalog);
}

/** A terminal tool's models with the catalog's newer ones in front. */
export function terminalModelsWithCatalog(tool: TerminalToolId, models: readonly string[], catalog: readonly CatalogModel[] | undefined): ModelsWithCatalog {
  return withCatalog(TERMINAL_TARGETS[tool], models, catalog);
}
