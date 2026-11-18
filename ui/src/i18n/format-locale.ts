/**
 * The locale dates and numbers are written in: US English until the language
 * provider knows the person's language and country (see formattingLocale in
 * @paperclipai/shared/app-languages), then theirs ("es-MX", "en-JM", "fr-HT").
 */
let current = "en-US";

export function formatLocale(): string {
  return current;
}

export function setFormatLocale(locale: string | null | undefined): void {
  current = locale && locale.trim() ? locale : "en-US";
}

/** Whether the board is in English: its own words ("5m ago") stay as they were written. */
export function formatsInEnglish(): boolean {
  return current === "en" || current.startsWith("en-");
}
