import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appLanguage, isAppLanguageCode, type AppLanguageCode } from "@paperclipai/shared";
import { UI_STRINGS } from "@paperclipai/shared/ui-strings.generated";
import { PUTER_DEFAULT_MODEL, puterChat, type PuterMessage } from "@paperclipai/shared/puter-ai";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

/**
 * Automa's screens in the languages it ships no translation for yet: the
 * board asks for the board strings a person sees, the free models translate
 * them once, and every later request (any person, any device) gets the saved
 * translation. Only strings from the board's own list (UI_STRINGS, extracted
 * from its code at build time) are accepted, so nothing a person wrote is
 * ever sent; templates arrive with their {0} placeholders, never the values.
 *
 * Saved per language in the instance folder (data/ui-translations/<code>.json),
 * like the model catalog: instance-level, app text only, no company data.
 */

/** Strings one free-model call translates. */
export const UI_TRANSLATION_BATCH = 30;
/** New (unsaved) strings one person may have translated per hour. */
export const UI_TRANSLATION_HOURLY_LIMIT = 2000;
const HOUR_MS = 60 * 60_000;

const BOARD_STRINGS = new Set(UI_STRINGS);

type Deps = {
  /** One free-model call: the messages in, the reply text out. */
  complete: (messages: PuterMessage[]) => Promise<string>;
  /** Where translations are kept; null keeps them in memory only. */
  dir: () => string | null;
  now: () => number;
  boardStrings: ReadonlySet<string>;
};

const defaultDeps = (): Deps => ({
  complete: (messages) => puterChat(messages, { model: PUTER_DEFAULT_MODEL, retries: 2 }),
  dir: () => path.join(resolvePaperclipInstanceRoot(), "data", "ui-translations"),
  now: () => Date.now(),
  boardStrings: BOARD_STRINGS,
});

function placeholders(text: string): string {
  return (text.match(/\{\d+\}/g) ?? []).sort().join(",");
}

const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?>/;
const URL = /\bhttps?:\/\//i;

/**
 * A translation the board may show for `source`, or null: not empty, not far
 * longer than the English, the same {n} placeholders, and no markup or links
 * the English does not have.
 */
export function acceptUiTranslation(source: string, candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const text = candidate.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > Math.max(source.length * 4, 80)) return null;
  if (placeholders(text) !== placeholders(source)) return null;
  if (HTML_TAG.test(text) && !HTML_TAG.test(source)) return null;
  if (URL.test(text) && !URL.test(source)) return null;
  return text;
}

/** What the free model is asked: translate these board strings into `language`. */
export function uiTranslationMessages(language: AppLanguageCode, strings: readonly string[]): PuterMessage[] {
  const entry = appLanguage(language);
  const name = entry.name === entry.nativeName ? entry.name : `${entry.name} (${entry.nativeName})`;
  return [
    {
      role: "system",
      content: [
        `You translate the words of Automa's interface from English into ${name}. Automa is an Android app where a team of AI agents works for a company: chats, tasks, agents, files, settings.`,
        `For each string write what a well-made app in ${entry.name} would show: natural, short and consistent, with the same meaning and tone. Buttons stay short.`,
        "Keep {0}, {1} and every other {n} exactly as they are: values are put there later.",
        "Keep the names of products, companies, AI models and brands as they are (Automa, Claude, GPT, Gemini, OpenRouter, Termux, App Studio, Moan, GitHub, Gmail, Slack and the like). Keep emoji, symbols and punctuation that mark structure (·, …, :).",
        "Answer with only a JSON array of strings: the translations, in the same order, exactly as many as you were given. No notes, no code fences.",
      ].join(" "),
    },
    { role: "user", content: JSON.stringify(strings) },
  ];
}

/** The JSON array in a model's reply, or null. */
export function parseTranslationReply(reply: string, expected: number): unknown[] | null {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) && parsed.length === expected ? parsed : null;
  } catch {
    return null;
  }
}

export interface UiTranslationResult {
  /** Translations of the requested strings that exist now. */
  translations: Record<string, string>;
  /** Requested board strings still without one (the model failed, or the hourly limit was reached). */
  pending: string[];
}

export function uiTranslationService(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...defaultDeps(), ...overrides };
  const saved = new Map<AppLanguageCode, Map<string, string>>();
  const inFlight = new Map<string, Promise<void>>();
  const usage = new Map<string, { since: number; count: number }>();

  function file(language: AppLanguageCode): string | null {
    const dir = deps.dir();
    return dir ? path.join(dir, `${language}.json`) : null;
  }

  function load(language: AppLanguageCode): Map<string, string> {
    let entries = saved.get(language);
    if (entries) return entries;
    entries = new Map();
    const target = file(language);
    if (target) {
      try {
        const raw = JSON.parse(readFileSync(target, "utf8")) as { entries?: Record<string, unknown> };
        for (const [source, translation] of Object.entries(raw.entries ?? {})) {
          // Strings the board no longer shows are dropped; damaged entries too.
          const accepted = deps.boardStrings.has(source) ? acceptUiTranslation(source, translation) : null;
          if (accepted) entries.set(source, accepted);
        }
      } catch {
        // None yet, or cut short: start empty.
      }
    }
    saved.set(language, entries);
    return entries;
  }

  function persist(language: AppLanguageCode): void {
    const target = file(language);
    if (!target) return;
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      const partial = `${target}.${process.pid}.part`;
      writeFileSync(partial, JSON.stringify({ version: 1, language, entries: Object.fromEntries(load(language)) }));
      renameSync(partial, target);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error), language }, "Could not save interface translations; they are kept in memory");
    }
  }

  /** Takes up to `wanted` from the person's hourly allowance; returns how many they may have. */
  function allowance(userId: string, wanted: number): number {
    const now = deps.now();
    const current = usage.get(userId);
    const window = current && now - current.since < HOUR_MS ? current : { since: now, count: 0 };
    const granted = Math.max(0, Math.min(wanted, UI_TRANSLATION_HOURLY_LIMIT - window.count));
    window.count += granted;
    usage.set(userId, window);
    return granted;
  }

  async function translateBatch(language: AppLanguageCode, batch: string[]): Promise<void> {
    let reply = "";
    try {
      reply = await deps.complete(uiTranslationMessages(language, batch));
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error), language, strings: batch.length }, "Free model could not translate interface strings");
      return;
    }
    const parsed = parseTranslationReply(reply, batch.length);
    if (!parsed) {
      // A reply with the wrong shape: try halves once, so one bad string does not sink the rest.
      if (batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        await translateBatch(language, batch.slice(0, middle));
        await translateBatch(language, batch.slice(middle));
      }
      return;
    }
    const entries = load(language);
    let added = 0;
    batch.forEach((source, index) => {
      const accepted = acceptUiTranslation(source, parsed[index]);
      if (accepted) {
        entries.set(source, accepted);
        added += 1;
      }
    });
    if (added > 0) persist(language);
  }

  return {
    /** Every saved translation for a language. */
    all(language: AppLanguageCode): Record<string, string> {
      return Object.fromEntries(load(language));
    },

    /**
     * Translations for the requested strings: saved ones at once, the rest
     * from the free models (each string once, however many ask). Strings that
     * are not the board's own are ignored.
     */
    async translate(language: AppLanguageCode, requested: readonly string[], userId: string): Promise<UiTranslationResult> {
      if (!isAppLanguageCode(language) || language === "en") return { translations: {}, pending: [] };
      const entries = load(language);
      const wanted = [...new Set(requested)].filter((source) => deps.boardStrings.has(source));
      const missing = wanted.filter((source) => !entries.has(source) && !inFlight.has(`${language}\u0000${source}`));
      const granted = missing.slice(0, allowance(userId, missing.length));
      const work: Promise<void>[] = [];
      for (let start = 0; start < granted.length; start += UI_TRANSLATION_BATCH) {
        const batch = granted.slice(start, start + UI_TRANSLATION_BATCH);
        const done = translateBatch(language, batch);
        for (const source of batch) inFlight.set(`${language}\u0000${source}`, done);
        work.push(done.finally(() => {
          for (const source of batch) inFlight.delete(`${language}\u0000${source}`);
        }));
      }
      // Strings another request is already translating are waited for too.
      const others = wanted
        .map((source) => inFlight.get(`${language}\u0000${source}`))
        .filter((promise): promise is Promise<void> => Boolean(promise));
      await Promise.all([...work, ...others]);
      const translations: Record<string, string> = {};
      const pending: string[] = [];
      for (const source of wanted) {
        const translation = entries.get(source);
        if (translation) translations[source] = translation;
        else pending.push(source);
      }
      return { translations, pending };
    },
  };
}

let shared: ReturnType<typeof uiTranslationService> | null = null;

/** The server's one translation service (one cache, one allowance per person). */
export function sharedUiTranslationService(): ReturnType<typeof uiTranslationService> {
  shared ??= uiTranslationService();
  return shared;
}

/** Tests: a fresh service with the given dependencies in place of the shared one. */
export function setSharedUiTranslationServiceForTests(service: ReturnType<typeof uiTranslationService> | null): void {
  shared = service;
}
