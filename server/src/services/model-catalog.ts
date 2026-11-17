import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { catalogReleaseDates, newCatalogModels, parseCatalogModels, placeCatalogModels, type CatalogModel, type CatalogTarget, type ModelCatalogSnapshot } from "@paperclipai/shared/model-catalog";
import { MODEL_CATALOG_SNAPSHOT, MODEL_CATALOG_SNAPSHOT_FETCHED_AT } from "@paperclipai/shared/model-catalog-snapshot";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

/**
 * The public model catalog (OpenRouter's, no credentials involved), one
 * download for every model list in Automa and for the free models' price
 * estimates.
 *
 * A downloaded catalog is kept in the instance folder (data/model-catalog.json),
 * so after a restart, or on a phone without a connection, the lists still show
 * the newest models this server has seen. Before its first download the
 * catalog shipped with Automa stands in (refreshed before each release with
 * `pnpm models:update`); a saved copy older than that one is skipped.
 *
 * Reading never waits on the network: a catalog more than 12 hours old is
 * answered at once and a new one downloads in the background (one at a time,
 * and not again within 10 minutes of a failed try). So a model released
 * tomorrow appears in the lists within half a day, with no Automa update.
 */
export const MODEL_CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const MODEL_CATALOG_FRESH_MS = 12 * 60 * 60_000;
export const MODEL_CATALOG_RETRY_MS = 10 * 60_000;
/** Fewer models than this is a broken answer, not a catalog: the list it had stays. */
const MIN_MODELS = 50;

type ModelCatalogDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Where the copy is kept; null keeps none. */
  savedFile: () => string | null;
  now: () => number;
  builtIn: () => ModelCatalogSnapshot;
  minModels: number;
};

const defaultDeps = (): ModelCatalogDeps => ({
  fetch: (url, init) => fetch(url, init),
  savedFile: () => path.join(resolvePaperclipInstanceRoot(), "data", "model-catalog.json"),
  now: () => Date.now(),
  builtIn: () => ({ source: "built-in", fetchedAt: MODEL_CATALOG_SNAPSHOT_FETCHED_AT, models: MODEL_CATALOG_SNAPSHOT }),
  minModels: MIN_MODELS,
});

let deps = defaultDeps();
let current: ModelCatalogSnapshot | null = null;
let pending: Promise<ModelCatalogSnapshot> | null = null;
let lastFailureAt = Number.NEGATIVE_INFINITY;

function fetchedAtMs(snapshot: ModelCatalogSnapshot): number {
  const at = Date.parse(snapshot.fetchedAt ?? "");
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

function isModel(value: unknown): value is CatalogModel {
  const model = value as Partial<CatalogModel> | null;
  return Boolean(model) && typeof model!.id === "string" && typeof model!.name === "string" &&
    typeof model!.created === "number" && Array.isArray(model!.output) && Array.isArray(model!.input);
}

function readSaved(): ModelCatalogSnapshot | null {
  const file = deps.savedFile();
  if (!file) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { fetchedAt?: unknown; models?: unknown };
    if (typeof raw.fetchedAt !== "string" || !Array.isArray(raw.models)) return null;
    const models = raw.models.filter(isModel);
    return models.length > 0 ? { source: "saved", fetchedAt: raw.fetchedAt, models } : null;
  } catch {
    // No copy yet, or one cut short: the built-in catalog stands in.
    return null;
  }
}

function save(snapshot: ModelCatalogSnapshot): void {
  const file = deps.savedFile();
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const partial = `${file}.${process.pid}.part`;
    writeFileSync(partial, JSON.stringify({ fetchedAt: snapshot.fetchedAt, models: snapshot.models }));
    renameSync(partial, file);
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Could not save the model catalog; it is kept in memory");
  }
}

function known(): ModelCatalogSnapshot {
  if (current) return current;
  const saved = readSaved();
  const shipped = deps.builtIn();
  current = saved && fetchedAtMs(saved) > fetchedAtMs(shipped) ? saved : shipped;
  return current;
}

/**
 * The catalog as known now. When it is more than 12 hours old a new one starts
 * downloading in the background; this call never waits for it.
 */
export function getModelCatalog(): ModelCatalogSnapshot {
  const snapshot = known();
  const now = deps.now();
  if (now - fetchedAtMs(snapshot) >= MODEL_CATALOG_FRESH_MS && !pending && now - lastFailureAt >= MODEL_CATALOG_RETRY_MS) {
    void refreshModelCatalog();
  }
  return snapshot;
}

/** Downloads the catalog now (joining one already under way) and saves it; on failure, answers with what was known. */
export function refreshModelCatalog(): Promise<ModelCatalogSnapshot> {
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await deps.fetch(MODEL_CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`the catalog answered ${response.status}`);
      const models = parseCatalogModels(await response.json());
      if (models.length < deps.minModels) throw new Error(`the catalog listed only ${models.length} models`);
      const snapshot: ModelCatalogSnapshot = { source: "live", fetchedAt: new Date(deps.now()).toISOString(), models };
      current = snapshot;
      save(snapshot);
      return snapshot;
    } catch (error) {
      lastFailureAt = deps.now();
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Could not download the model catalog; the model lists keep what they had");
      return known();
    }
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/**
 * An adapter's model list with the catalog's models for `target` it lacks
 * (released in the last 180 days), placed by release date after the first
 * `keepFirst` entries (an "Auto" or default entry stays on top): a model out
 * after everything on the list lands right below those, an older one by the
 * models of its time (`placeCatalogModels`).
 */
export function withCatalogModels(target: CatalogTarget, models: AdapterModel[], keepFirst = 0): AdapterModel[] {
  const catalog = getModelCatalog().models;
  const added = newCatalogModels(target, models.map((model) => model.id), catalog);
  if (added.length === 0) return models;
  return placeCatalogModels(models, added, {
    id: (model) => model.id,
    entry: ({ id, label }) => ({ id, label }),
    released: catalogReleaseDates(target, catalog),
    keepFirst,
  });
}

/** Tests: replace any of the catalog's dependencies and forget what it knew. */
export function configureModelCatalogForTests(overrides: Partial<ModelCatalogDeps>): void {
  deps = { ...defaultDeps(), ...overrides };
  current = null;
  pending = null;
  lastFailureAt = Number.NEGATIVE_INFINITY;
}

/** Tests: the real dependencies again, and nothing known. */
export function resetModelCatalogForTests(): void {
  configureModelCatalogForTests({});
}
