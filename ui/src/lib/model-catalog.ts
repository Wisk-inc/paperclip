import { useQuery } from "@tanstack/react-query";
import { catalogReleaseDates, newCatalogModels, placeCatalogModels, type CatalogModel, type CatalogTarget, type ModelCatalogSnapshot } from "@paperclipai/shared/model-catalog";
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
  /** The list as it was with the catalog's models it lacked placed by release date (newest models on top). */
  models: string[];
  /** The ones the catalog added. */
  added: ReadonlySet<string>;
  /** Of those, the ones released in the last 30 days: shown as New. */
  fresh: ReadonlySet<string>;
}

const FRESH_SECONDS = 30 * 86_400;

function withCatalog(target: CatalogTarget | undefined, models: readonly string[], catalog: readonly CatalogModel[] | undefined): ModelsWithCatalog {
  if (!target || !catalog?.length) return { models: [...models], added: new Set(), fresh: new Set() };
  const added = newCatalogModels(target, models, catalog);
  const since = Date.now() / 1000 - FRESH_SECONDS;
  return {
    models: placeCatalogModels(models, added, { id: (id) => id, entry: (model) => model.id, released: catalogReleaseDates(target, catalog) }),
    added: new Set(added.map((model) => model.id)),
    fresh: new Set(added.filter((model) => model.created >= since).map((model) => model.id)),
  };
}

/** An App Studio provider's models with the catalog's ones it lacked, placed by release date. */
export function studioModelsWithCatalog(provider: StudioAiProvider, models: readonly string[], catalog: readonly CatalogModel[] | undefined): ModelsWithCatalog {
  return withCatalog(STUDIO_TARGETS[provider], models, catalog);
}

/** A terminal tool's models with the catalog's ones it lacked, placed by release date. */
export function terminalModelsWithCatalog(tool: TerminalToolId, models: readonly string[], catalog: readonly CatalogModel[] | undefined): ModelsWithCatalog {
  return withCatalog(TERMINAL_TARGETS[tool], models, catalog);
}

/** How far back the chat model picker's Newest models section looks, and how many it lists. */
const NEWEST_DAYS = 60;
const NEWEST_LIMIT = 16;

/**
 * The catalog's newest chat models from the major makers that take tools, as
 * OpenRouter ids ("maker/model"), newest first: the chat model picker's Newest
 * models. Counted back from when the catalog was downloaded, so a server that
 * has been offline for months still lists the newest it knows. Null without a
 * catalog (a server before 1.9.13 has none), so the picker keeps its own list.
 */
export function newestCatalogModelIds(snapshot: Pick<ModelCatalogSnapshot, "fetchedAt" | "models"> | undefined): string[] | null {
  if (!snapshot?.models.length) return null;
  const fetchedAt = Date.parse(snapshot.fetchedAt ?? "");
  return newCatalogModels("openrouter", [], snapshot.models, {
    now: Number.isFinite(fetchedAt) ? fetchedAt : Date.now(),
    days: NEWEST_DAYS,
    limit: NEWEST_LIMIT,
  }).map((model) => model.id);
}
