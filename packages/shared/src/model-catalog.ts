/**
 * The public model catalog: every model from every major maker with its
 * release date (OpenRouter's /api/v1/models, which needs no credentials). The
 * server keeps a copy (services/model-catalog.ts) and every model list in
 * Automa (agents, App Studio, Terminals) shows the catalog's newer models next
 * to its own built-in ones, so a model released tomorrow shows up without an
 * Automa update.
 */

/** One model in the catalog. */
export interface CatalogModel {
  /** The catalog's id: "google/gemini-4-hydrogen". */
  id: string;
  /** The catalog's name: "Google: Gemini 4 Hydrogen". */
  name: string;
  /** Released, in seconds since 1970. */
  created: number;
  context: number | null;
  /** Takes tools (function calling). */
  tools: boolean;
  input: string[];
  output: string[];
  /** List price in US dollars per token; null when the catalog gives none. */
  price: { input: number; output: number } | null;
}

export interface ModelCatalogSnapshot {
  /** live: downloaded by this server; saved: its copy from an earlier run; built-in: shipped with Automa. */
  source: "live" | "saved" | "built-in";
  /** When the catalog was downloaded (ISO); null when unknown. */
  fetchedAt: string | null;
  /** Newest first. */
  models: CatalogModel[];
}

/**
 * The model lists that follow the catalog, named for whose model ids they use:
 * the Anthropic, OpenAI, Google (Gemini), xAI and Moonshot APIs and CLIs, and
 * OpenRouter (the catalog's own "maker/model" ids).
 */
export type CatalogTarget = "anthropic" | "openai" | "google" | "xai" | "moonshot" | "openrouter";

/** The makers whose models the OpenRouter lists offer; the rest of the catalog is long-tail. */
export const CATALOG_TOP_MAKERS = [
  "anthropic",
  "openai",
  "google",
  "x-ai",
  "moonshotai",
  "deepseek",
  "qwen",
  "mistralai",
  "z-ai",
  "minimax",
  "meta-llama",
  "nvidia",
  "cohere",
] as const;

/** ":free", ":batch", ":thinking"…: another way to call a model the catalog already lists. */
const VARIANT_SUFFIX = /:[a-z0-9-]+$/i;
/** Models for pictures, sound, video, search, embeddings or moderation, not chat. */
const NOT_CHAT = /(?:^|[/-])(?:image|images|imagen|tts|audio|realtime|transcribe|embedding|embeddings|embed|moderation|search|veo|lyria|nano-banana|guard|live)(?:[-.]|$)/i;

function asNumber(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The catalog's answer as CatalogModels, newest first. Entries without an
 * id, a maker or a release date are dropped; anything else odd is read
 * leniently, since the catalog belongs to someone else.
 */
export function parseCatalogModels(body: unknown): CatalogModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("The model catalog answered without a model list.");
  const models: CatalogModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const created = asNumber(entry.created);
    if (!id.includes("/") || created === null) continue;
    const architecture = (entry.architecture ?? {}) as Record<string, unknown>;
    const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
    const input = asNumber(pricing.prompt);
    const output = asNumber(pricing.completion);
    models.push({
      id,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
      created,
      context: asNumber(entry.context_length),
      tools: asStrings(entry.supported_parameters).includes("tools"),
      input: asStrings(architecture.input_modalities),
      output: asStrings(architecture.output_modalities),
      price: input !== null && output !== null && (input > 0 || output > 0) ? { input, output } : null,
    });
  }
  return models.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
}

/** A chat model: answers in text, is not a variant of another entry, and is not for pictures, sound or search. */
export function isCatalogChatModel(model: Pick<CatalogModel, "id" | "output">): boolean {
  if (VARIANT_SUFFIX.test(model.id)) return false;
  if (model.output.length > 0 && !model.output.includes("text")) return false;
  return !NOT_CHAT.test(model.id.slice(model.id.indexOf("/") + 1));
}

/**
 * The id `target` uses for catalog model `id`, or null when that list does
 * not take it. Anthropic writes versions with dashes ("anthropic/claude-fable-5.2"
 * is "claude-fable-5-2"); the others use the catalog's name without the maker.
 */
export function catalogNativeId(target: CatalogTarget, id: string): string | null {
  const slash = id.indexOf("/");
  if (slash <= 0) return null;
  const maker = id.slice(0, slash);
  const name = id.slice(slash + 1);
  switch (target) {
    case "anthropic":
      return maker === "anthropic" && /^claude-[a-z]+-\d+(?:\.\d+)?$/.test(name) ? name.replace(/\./g, "-") : null;
    case "openai":
      // gpt-oss is open-weight: other hosts serve it, OpenAI's API does not.
      return maker === "openai" && /^(?:gpt-\d|o\d)/.test(name) && !name.startsWith("gpt-oss") ? name : null;
    case "google":
      return maker === "google" && name.startsWith("gemini-") ? name : null;
    case "xai":
      return maker === "x-ai" && name.startsWith("grok-") ? name : null;
    case "moonshot":
      return maker === "moonshotai" && name.startsWith("kimi-") ? name : null;
    case "openrouter":
      return (CATALOG_TOP_MAKERS as readonly string[]).includes(maker) ? id : null;
  }
}

/** The catalog's name without its maker: "Google: Gemini 4 Hydrogen" is "Gemini 4 Hydrogen". */
export function catalogLabel(model: Pick<CatalogModel, "id" | "name">): string {
  const colon = model.name.indexOf(": ");
  return colon > 0 ? model.name.slice(colon + 2) : model.name;
}

export interface NewCatalogModel {
  /** The id in the target's own form. */
  id: string;
  label: string;
  created: number;
}

/**
 * The catalog's chat models for `target` released in the last `days` days that
 * `known` does not have yet, newest first, at most `limit`. Only models that
 * take tools: every list that follows the catalog (agents, App Studio, coding
 * terminals) works through tool calls.
 */
export function newCatalogModels(
  target: CatalogTarget,
  known: Iterable<string>,
  catalog: readonly CatalogModel[],
  options: { now?: number; days?: number; limit?: number } = {},
): NewCatalogModel[] {
  const now = options.now ?? Date.now();
  const since = now / 1000 - (options.days ?? 180) * 86_400;
  const limit = options.limit ?? 12;
  const seen = new Set(known);
  const found: NewCatalogModel[] = [];
  for (const model of catalog) {
    if (found.length >= limit) break;
    if (model.created < since || !model.tools || !isCatalogChatModel(model)) continue;
    const id = catalogNativeId(target, model.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    found.push({ id, label: catalogLabel(model), created: model.created });
  }
  return found.sort((a, b) => b.created - a.created);
}

/** When each model came out (seconds since 1970), by its id in `target`'s form. */
export function catalogReleaseDates(target: CatalogTarget, catalog: readonly CatalogModel[]): Map<string, number> {
  const dates = new Map<string, number>();
  for (const model of catalog) {
    const id = catalogNativeId(target, model.id);
    if (id && !dates.has(id)) dates.set(id, model.created);
  }
  return dates;
}

/**
 * `list` with the catalog's models it lacks placed by release date, so it
 * reads newest first where it can without reordering what it has: each goes
 * just above the first model on the list (after the first `keepFirst`, an
 * "Auto" or default entry) that came out before it, or that the catalog does
 * not date; one older than every dated model on the list goes at the end. A
 * model out tomorrow lands on top.
 */
export function placeCatalogModels<T>(
  list: readonly T[],
  added: readonly NewCatalogModel[],
  how: { id: (item: T) => string; entry: (model: NewCatalogModel) => T; released: ReadonlyMap<string, number>; keepFirst?: number },
): T[] {
  const keepFirst = how.keepFirst ?? 0;
  const rest = list.slice(keepFirst);
  const above = new Map<number, NewCatalogModel[]>();
  const atEnd: NewCatalogModel[] = [];
  for (const model of [...added].sort((a, b) => b.created - a.created)) {
    const index = rest.findIndex((item) => {
      const released = how.released.get(how.id(item));
      return released === undefined || released < model.created;
    });
    if (index < 0) atEnd.push(model);
    else above.set(index, [...(above.get(index) ?? []), model]);
  }
  const placed = list.slice(0, keepFirst);
  rest.forEach((item, index) => {
    for (const model of above.get(index) ?? []) placed.push(how.entry(model));
    placed.push(item);
  });
  for (const model of atEnd) placed.push(how.entry(model));
  return placed;
}

/** `known` with the catalog's models for `target` it lacks, placed by release date (`placeCatalogModels`). */
export function withNewCatalogModels(
  target: CatalogTarget,
  known: readonly string[],
  catalog: readonly CatalogModel[],
  options: { now?: number; days?: number; limit?: number } = {},
): string[] {
  return placeCatalogModels(known, newCatalogModels(target, known, catalog, options), {
    id: (id) => id,
    entry: (model) => model.id,
    released: catalogReleaseDates(target, catalog),
  });
}
