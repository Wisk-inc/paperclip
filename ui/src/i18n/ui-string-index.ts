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
   *
   * `pieces` are those parts (the text nodes React wrote side by side). The
   * board writes a template's fixed words as text of their own and each value
   * as its own part, so a template matches pieces only when every value starts
   * and ends where a piece does: "{0} changed {1}" is not read into
   * "Backend files changed since this server booted." next to " Updated 5m ago.",
   * two parts that are each the board's own text.
   */
  match(text: string, pieced: boolean, pieces?: readonly string[]): UiStringMatch | null;
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
  /** The fixed text before, between and after the placeholders (one more than the placeholders). */
  fixed: string[];
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
  const fixed: string[] = [];
  let pattern = "^";
  let last = 0;
  for (const match of source.matchAll(PLACEHOLDER)) {
    fixed.push(source.slice(last, match.index));
    pattern += escapeRegExp(source.slice(last, match.index));
    pattern += "(.*?)";
    order.push(Number(match[1]));
    last = match.index! + match[0].length;
  }
  fixed.push(source.slice(last));
  pattern += `${escapeRegExp(source.slice(last))}$`;
  const letters = source.replace(PLACEHOLDER, "");
  return { source, pattern: new RegExp(pattern, "su"), fixed, fixedLetters: (letters.match(/\p{L}/gu) ?? []).length, order };
}

/**
 * Where the pieces meet, as positions in normalizeUiText(pieces.join("")):
 * the start, the end, and every place one piece ends and the next begins.
 */
export function pieceBoundaries(pieces: readonly string[]): Set<number> {
  const joined = pieces.join("");
  const total = normalizeUiText(joined).length;
  // The normalized position of each position in `joined`: leading space dropped, runs of space made one.
  const at: number[] = [];
  let out = 0;
  let started = false;
  let inSpace = false;
  for (let i = 0; i < joined.length; i += 1) {
    at.push(out);
    if (/\s/.test(joined[i]!)) {
      if (started && !inSpace) out += 1;
      inSpace = true;
    } else {
      out += 1;
      started = true;
      inSpace = false;
    }
  }
  at.push(out);
  const boundaries = new Set<number>([0, total]);
  let offset = 0;
  for (const piece of pieces) {
    offset += piece.length;
    boundaries.add(Math.min(at[offset]!, total));
  }
  return boundaries;
}

/** Whether every value of a template match starts and ends where pieces meet (a space either side allowed). */
function valuesFollowPieces(template: Template, found: RegExpExecArray, text: string, boundaries: Set<number>): boolean {
  const meets = (position: number) =>
    boundaries.has(position) ||
    (text[position - 1] === " " && boundaries.has(position - 1)) ||
    (text[position] === " " && boundaries.has(position + 1));
  let position = template.fixed[0]!.length;
  for (let index = 0; index < template.order.length; index += 1) {
    const value = found[index + 1] ?? "";
    if (!meets(position) || !meets(position + value.length)) return false;
    position += value.length + template.fixed[index + 1]!.length;
  }
  return true;
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
    match(text, pieced, pieces) {
      const normalized = normalizeUiText(text);
      if (!normalized) return null;
      if (exact.has(normalized)) return { source: normalized, values: [] };
      const boundaries = pieced && pieces && pieces.length > 1 ? pieceBoundaries(pieces) : null;
      const seen = new Set<Template>();
      let best: { template: Template; values: string[] } | null = null;
      const consider = (template: Template) => {
        if (seen.has(template)) return;
        seen.add(template);
        if (!pieced && template.fixedLetters < MIN_FIXED_LETTERS_UNPIECED) return;
        if (best && best.template.fixedLetters >= template.fixedLetters) return;
        const found = template.pattern.exec(normalized);
        if (!found) return;
        if (boundaries && !valuesFollowPieces(template, found, normalized, boundaries)) return;
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
