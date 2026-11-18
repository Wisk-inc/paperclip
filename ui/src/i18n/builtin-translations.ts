import type { AppLanguageCode } from "@paperclipai/shared";

/**
 * The translations Automa ships for its core screens: one file per language
 * (English source → translation, the sources listed in builtin-core.ts), each
 * loaded only when that language is in use.
 */
const files = import.meta.glob<Record<string, string>>("./builtin/*.json", { import: "default" });

export function hasBuiltinTranslations(language: AppLanguageCode): boolean {
  return `./builtin/${language}.json` in files;
}

export async function loadBuiltinTranslations(language: AppLanguageCode): Promise<Record<string, string>> {
  const load = files[`./builtin/${language}.json`];
  return load ? await load() : {};
}
