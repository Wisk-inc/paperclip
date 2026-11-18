/**
 * Which on-screen text is the board's own wording, from the list the build
 * extracts (UI_STRINGS): exact strings ("Sign out") and templates with values
 * filled in at run time ("Delete {0} files?"). Only text that matches is ever
 * translated, so a person's own words (chats, tasks, names) never are.
 */

export interface UiStringMatch {
  /** The English string or template, as the list has it. */
  source: string;
  /** What filled each {n} of a template, in order; empty for exact strings. */
  values: string[];
}

export interface UiStringIndex {
  /** How many strings and templates the list holds. */
  size: number;
  has(source: string): boolean;
  /**
   * The board string `text` is, or null. A template whose fixed words are few
   * ("On {0}") is trusted only when `pieced` says the text was assembled from
   * several parts on the page (a value was filled in), so a person's sentence
   * that happens to start with "On" is left alone.
   */
  match(text: string, pieced: boolean): UiStringMatch | null;
}

const PLACEHOLDER = /\{(\d+)\}/g;
/** Fixed letters a template needs before a single piece of text may match it. */
const MIN_FIXED_LETTERS_UNPIECED = 6;

/** Collapses whitespace the way the extractor stored the strings. */
export function normalizeUiText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface Template {
  source: string;
  pattern: RegExp;
  /** Letters outside the placeholders. */
  fixedLetters: number;
  /** Placeholder numbers in the order they appear. */
  order: number[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTemplate(source: string): Template {
  const order: number[] = [];
  let pattern = "^";
  let last = 0;
  for (const match of source.matchAll(PLACEHOLDER)) {
    pattern += escapeRegExp(source.slice(last, match.index));
    pattern += "(.*?)";
    order.push(Number(match[1]));
    last = match.index! + match[0].length;
  }
  pattern += `${escapeRegExp(source.slice(last))}$`;
  const fixed = source.replace(PLACEHOLDER, "");
  return { source, pattern: new RegExp(pattern, "su"), fixedLetters: (fixed.match(/\p{L}/gu) ?? []).length, order };
}

/** Words of three or more letters, lowercased: how templates are found. */
function keyWords(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}{3,}/gu) ?? []);
}

export function buildUiStringIndex(strings: readonly string[]): UiStringIndex {
  const exact = new Set<string>();
  const templates: Template[] = [];
  const templateSources = new Set<string>();
  const byWord = new Map<string, Template[]>();
  /** Templates whose fixed words are all short ("{0} of {1}", "by {0}"): only pieced text can match them. */
  const keyless: Template[] = [];
  for (const raw of strings) {
    const source = normalizeUiText(raw);
    if (!source) continue;
    if (!/\{\d+\}/.test(source)) {
      exact.add(source);
      continue;
    }
    if (templateSources.has(source)) continue;
    const template = compileTemplate(source);
    templates.push(template);
    templateSources.add(source);
    // Indexed by its rarest-looking (longest) fixed word.
    const words = keyWords(source.replace(PLACEHOLDER, " "));
    const key = words.sort((a, b) => b.length - a.length)[0];
    if (!key) {
      keyless.push(template);
      continue;
    }
    const list = byWord.get(key) ?? [];
    list.push(template);
    byWord.set(key, list);
  }
  for (const list of byWord.values()) list.sort((a, b) => b.fixedLetters - a.fixedLetters);
  keyless.sort((a, b) => b.fixedLetters - a.fixedLetters);

  return {
    size: exact.size + templates.length,
    has: (source) => exact.has(source) || templateSources.has(source),
    match(text, pieced) {
      const normalized = normalizeUiText(text);
      if (!normalized) return null;
      if (exact.has(normalized)) return { source: normalized, values: [] };
      const seen = new Set<Template>();
      let best: { template: Template; values: string[] } | null = null;
      const consider = (template: Template) => {
        if (seen.has(template)) return;
        seen.add(template);
        if (!pieced && template.fixedLetters < MIN_FIXED_LETTERS_UNPIECED) return;
        if (best && best.template.fixedLetters >= template.fixedLetters) return;
        const found = template.pattern.exec(normalized);
        if (!found) return;
        const values: string[] = [];
        template.order.forEach((placeholder, index) => {
          values[placeholder] = found[index + 1] ?? "";
        });
        best = { template, values };
      };
      for (const word of new Set(keyWords(normalized))) {
        for (const template of byWord.get(word) ?? []) consider(template);
      }
      // Their few letters are under the unpieced minimum, so only pieced text is checked against them.
      if (pieced) for (const template of keyless) consider(template);
      const chosen = best as { template: Template; values: string[] } | null;
      return chosen ? { source: chosen.template.source, values: chosen.values } : null;
    },
  };
}

/** A template's translation with its values put back in. */
export function fillTemplate(translation: string, values: readonly string[]): string {
  return translation.replace(PLACEHOLDER, (_whole, digits: string) => values[Number(digits)] ?? "");
}

let loaded: Promise<UiStringIndex> | null = null;

/** The board's list of strings, loaded once and only when a language other than English is in use. */
export function loadUiStringIndex(): Promise<UiStringIndex> {
  loaded ??= import("@paperclipai/shared/ui-strings.generated").then((module) => buildUiStringIndex(module.UI_STRINGS));
  return loaded;
}
