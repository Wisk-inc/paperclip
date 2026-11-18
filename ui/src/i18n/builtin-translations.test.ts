import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_LANGUAGE_CODES, type AppLanguageCode } from "@paperclipai/shared";
import { UI_STRINGS } from "@paperclipai/shared/ui-strings.generated";
import { BUILTIN_CORE_STRINGS } from "./builtin-core";
import { hasBuiltinTranslations, loadBuiltinTranslations } from "./builtin-translations";
import { buildUiStringIndex } from "./ui-string-index";

const BUILTIN_DIR = path.join(import.meta.dirname, "builtin");
const TRANSLATED = APP_LANGUAGE_CODES.filter((code): code is Exclude<AppLanguageCode, "en"> => code !== "en");

/**
 * The writing each language uses: every long sentence must contain it, except
 * for Czech and Vietnamese, which share the Latin alphabet and are told apart
 * by their own letters; a correct sentence can lack them ("Hledat agenty nebo
 * modely"), so most of their sentences must have them, not each one. Japanese
 * is the same with kana: a sentence may be all kanji, most are not.
 */
const SCRIPT: Record<Exclude<AppLanguageCode, "en">, RegExp> = {
  ar: /\p{Script=Arabic}/u,
  bn: /\p{Script=Bengali}/u,
  cs: /[áčďéěíňóřšťúůýž]/iu,
  da: /\p{Script=Latin}/u,
  de: /\p{Script=Latin}/u,
  el: /\p{Script=Greek}/u,
  es: /\p{Script=Latin}/u,
  fa: /\p{Script=Arabic}/u,
  fi: /\p{Script=Latin}/u,
  fil: /\p{Script=Latin}/u,
  fr: /\p{Script=Latin}/u,
  he: /\p{Script=Hebrew}/u,
  hi: /\p{Script=Devanagari}/u,
  hu: /\p{Script=Latin}/u,
  id: /\p{Script=Latin}/u,
  it: /\p{Script=Latin}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
  ko: /\p{Script=Hangul}/u,
  mr: /\p{Script=Devanagari}/u,
  ms: /\p{Script=Latin}/u,
  nb: /\p{Script=Latin}/u,
  nl: /\p{Script=Latin}/u,
  pa: /\p{Script=Gurmukhi}/u,
  pl: /\p{Script=Latin}/u,
  "pt-BR": /\p{Script=Latin}/u,
  "pt-PT": /\p{Script=Latin}/u,
  ro: /\p{Script=Latin}/u,
  ru: /\p{Script=Cyrillic}/u,
  sv: /\p{Script=Latin}/u,
  sw: /\p{Script=Latin}/u,
  ta: /\p{Script=Tamil}/u,
  te: /\p{Script=Telugu}/u,
  th: /\p{Script=Thai}/u,
  tr: /\p{Script=Latin}/u,
  uk: /\p{Script=Cyrillic}/u,
  ur: /\p{Script=Arabic}/u,
  vi: /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu,
  "zh-CN": /\p{Script=Han}/u,
  "zh-TW": /\p{Script=Han}/u,
};

const BY_SHARE = new Set<AppLanguageCode>(["cs", "vi", "ja"]);
/** What every sentence of a language checked by share must still be written in. */
const ALPHABET: Partial<Record<AppLanguageCode, RegExp>> = {
  cs: /\p{Script=Latin}/u,
  vi: /\p{Script=Latin}/u,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
};
const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

function read(code: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(BUILTIN_DIR, `${code}.json`), "utf8")) as Record<string, unknown>;
}

describe("the core list", () => {
  it("is the board's own wording, exactly as its code writes it, once each", () => {
    const board = new Set(UI_STRINGS);
    expect(BUILTIN_CORE_STRINGS.filter((source) => !board.has(source))).toEqual([]);
    expect(new Set(BUILTIN_CORE_STRINGS).size).toBe(BUILTIN_CORE_STRINGS.length);
  });

  it("is what the on-screen translator matches", () => {
    const index = buildUiStringIndex(UI_STRINGS);
    for (const source of BUILTIN_CORE_STRINGS) expect(index.has(source)).toBe(true);
  });
});

describe("built-in translations", () => {
  it("ship for every language but English, and nothing else", () => {
    const files = readdirSync(BUILTIN_DIR).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, ""));
    expect(files.sort()).toEqual([...TRANSLATED].sort());
    for (const code of TRANSLATED) expect(hasBuiltinTranslations(code)).toBe(true);
    expect(hasBuiltinTranslations("en")).toBe(false);
  });

  describe.each(TRANSLATED)("%s", (code) => {
    const translations = read(code);

    it("translates every core string, and only those", () => {
      const keys = Object.keys(translations);
      expect(keys.filter((key) => !BUILTIN_CORE_STRINGS.includes(key))).toEqual([]);
      expect(BUILTIN_CORE_STRINGS.filter((source) => !(source in translations))).toEqual([]);
    });

    it("keeps each value's placeholders and writes no markup", () => {
      for (const [source, value] of Object.entries(translations)) {
        expect(typeof value, source).toBe("string");
        const text = value as string;
        expect(text.trim(), source).not.toBe("");
        expect(text, source).toBe(text.trim());
        expect(placeholders(text), source).toEqual(placeholders(source));
        expect(/<[a-z/!]|https?:\/\//i.test(text), source).toBe(false);
      }
    });

    it("is written in the language's own script, and its sentences are translated", () => {
      const sentences = Object.entries(translations).filter(([source]) => words(source) >= 4);
      for (const [source, value] of sentences) expect(value as string, source).not.toBe(source);
      const written = sentences.filter(([, value]) => SCRIPT[code].test(value as string));
      if (BY_SHARE.has(code)) {
        expect(written.length / sentences.length).toBeGreaterThan(0.8);
        expect(sentences.filter(([, value]) => !ALPHABET[code]!.test(value as string)).map(([source]) => source)).toEqual([]);
      } else {
        expect(sentences.filter(([, value]) => !SCRIPT[code].test(value as string)).map(([source]) => source)).toEqual([]);
      }
    });

    it("keeps Automa's name (Hungarian adds its endings to it: \"az Automába\")", () => {
      for (const [source, value] of Object.entries(translations)) {
        if (/\bAutoma\b/.test(source)) expect(value as string, source).toMatch(/Autom[aá]/);
      }
    });
  });

  it("load for the language in use", async () => {
    const spanish = await loadBuiltinTranslations("es");
    expect(spanish["Sign out"]).toBeTruthy();
    expect(Object.keys(spanish)).toHaveLength(BUILTIN_CORE_STRINGS.length);
    expect(await loadBuiltinTranslations("en")).toEqual({});
  });
});
