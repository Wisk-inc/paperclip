import { useSyncExternalStore } from "react";

/**
 * The locale dates and numbers are written in: US English until the language
 * provider knows the person's language and country (see formattingLocale in
 * @paperclipai/shared/app-languages), then theirs ("es-MX", "en-JM", "fr-HT").
 * Every date and number the board formats goes through it, never the phone's
 * own locale, so they follow the language chosen in Automa.
 */
let current = "en-US";
const listeners = new Set<() => void>();

/**
 * The locale with Western digits. The board writes many numbers as they are
 * ("7 agents", "11s", versions, ids), so formatted ones use the same digits in
 * every language: an Arabic, Persian, Bengali or Marathi screen never shows two
 * kinds side by side. The language's own separators, names and calendar stay.
 */
function withWesternDigits(locale: string): string {
  try {
    if (new Intl.NumberFormat(locale).resolvedOptions().numberingSystem === "latn") return locale;
    return new Intl.Locale(locale, { numberingSystem: "latn" }).toString();
  } catch {
    // An engine without Intl.Locale, or a locale it does not know: as given.
    return locale;
  }
}

export function formatLocale(): string {
  return current;
}

export function setFormatLocale(locale: string | null | undefined): void {
  const trimmed = locale?.trim();
  const next = trimmed ? withWesternDigits(trimmed) : "en-US";
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

/** Called whenever the locale changes; returns the way to stop. */
export function subscribeFormatLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The locale, for a component that must draw again when it changes. Text is
 * translated where it stands, but a date or number is written when its
 * component renders: without this, switching language left the ones already on
 * screen in the old format until a reload. The board's root uses it, so every
 * page renders again (nothing is remounted, so what someone is typing stays),
 * and so does each memoized component, which would otherwise keep its output.
 */
export function useFormatLocale(): string {
  return useSyncExternalStore(subscribeFormatLocale, formatLocale, formatLocale);
}

/** Whether the board is in English: its own words ("5m ago") stay as they were written. */
export function formatsInEnglish(): boolean {
  return current === "en" || current.startsWith("en-");
}
