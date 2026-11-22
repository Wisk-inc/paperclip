import { TIME_ZONE_COUNTRIES } from "./time-zone-countries.js";

/**
 * The languages Automa's screens come in, and how "Auto" picks one: from the
 * languages the phone or browser lists, first match wins, with the country
 * from the time zone (where the person is) or else the locale's region (how
 * they set the phone up). Nothing is looked up online.
 */

export interface AppLanguage {
  /** The code Automa uses: a language ("es"), or language and region where the two read differently ("pt-BR", "zh-TW"). */
  code: AppLanguageCode;
  /** The name in English. */
  name: string;
  /** The name in the language itself, as the picker shows it. */
  nativeName: string;
  /** Written right to left. */
  rtl: boolean;
}

export const APP_LANGUAGE_CODES = [
  "en", "ar", "bn", "cs", "da", "de", "el", "es", "fa", "fi",
  "fil", "fr", "he", "hi", "hu", "id", "it", "ja", "ko", "mr",
  "ms", "nb", "nl", "pa", "pl", "pt-BR", "pt-PT", "ro", "ru", "sv",
  "sw", "ta", "te", "th", "tr", "uk", "ur", "vi", "zh-CN", "zh-TW",
] as const;

export type AppLanguageCode = (typeof APP_LANGUAGE_CODES)[number];

/** The saved choice: "auto", or one of the languages. */
export type AppLanguagePreference = "auto" | AppLanguageCode;

export const APP_LANGUAGE_AUTO = "auto" as const;
export const DEFAULT_APP_LANGUAGE: AppLanguageCode = "en";

export const APP_LANGUAGES: readonly AppLanguage[] = [
  { code: "en", name: "English", nativeName: "English", rtl: false },
  { code: "ar", name: "Arabic", nativeName: "العربية", rtl: true },
  { code: "bn", name: "Bengali", nativeName: "বাংলা", rtl: false },
  { code: "cs", name: "Czech", nativeName: "Čeština", rtl: false },
  { code: "da", name: "Danish", nativeName: "Dansk", rtl: false },
  { code: "de", name: "German", nativeName: "Deutsch", rtl: false },
  { code: "el", name: "Greek", nativeName: "Ελληνικά", rtl: false },
  { code: "es", name: "Spanish", nativeName: "Español", rtl: false },
  { code: "fa", name: "Persian", nativeName: "فارسی", rtl: true },
  { code: "fi", name: "Finnish", nativeName: "Suomi", rtl: false },
  { code: "fil", name: "Filipino", nativeName: "Filipino", rtl: false },
  { code: "fr", name: "French", nativeName: "Français", rtl: false },
  { code: "he", name: "Hebrew", nativeName: "עברית", rtl: true },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी", rtl: false },
  { code: "hu", name: "Hungarian", nativeName: "Magyar", rtl: false },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", rtl: false },
  { code: "it", name: "Italian", nativeName: "Italiano", rtl: false },
  { code: "ja", name: "Japanese", nativeName: "日本語", rtl: false },
  { code: "ko", name: "Korean", nativeName: "한국어", rtl: false },
  { code: "mr", name: "Marathi", nativeName: "मराठी", rtl: false },
  { code: "ms", name: "Malay", nativeName: "Bahasa Melayu", rtl: false },
  { code: "nb", name: "Norwegian", nativeName: "Norsk bokmål", rtl: false },
  { code: "nl", name: "Dutch", nativeName: "Nederlands", rtl: false },
  { code: "pa", name: "Punjabi", nativeName: "ਪੰਜਾਬੀ", rtl: false },
  { code: "pl", name: "Polish", nativeName: "Polski", rtl: false },
  { code: "pt-BR", name: "Portuguese (Brazil)", nativeName: "Português (Brasil)", rtl: false },
  { code: "pt-PT", name: "Portuguese (Portugal)", nativeName: "Português (Portugal)", rtl: false },
  { code: "ro", name: "Romanian", nativeName: "Română", rtl: false },
  { code: "ru", name: "Russian", nativeName: "Русский", rtl: false },
  { code: "sv", name: "Swedish", nativeName: "Svenska", rtl: false },
  { code: "sw", name: "Swahili", nativeName: "Kiswahili", rtl: false },
  { code: "ta", name: "Tamil", nativeName: "தமிழ்", rtl: false },
  { code: "te", name: "Telugu", nativeName: "తెలుగు", rtl: false },
  { code: "th", name: "Thai", nativeName: "ไทย", rtl: false },
  { code: "tr", name: "Turkish", nativeName: "Türkçe", rtl: false },
  { code: "uk", name: "Ukrainian", nativeName: "Українська", rtl: false },
  { code: "ur", name: "Urdu", nativeName: "اردو", rtl: true },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt", rtl: false },
  { code: "zh-CN", name: "Chinese (Simplified)", nativeName: "简体中文", rtl: false },
  { code: "zh-TW", name: "Chinese (Traditional)", nativeName: "繁體中文", rtl: false },
];

const BY_CODE = new Map<string, AppLanguage>(APP_LANGUAGES.map((language) => [language.code, language]));

export function isAppLanguageCode(value: unknown): value is AppLanguageCode {
  return typeof value === "string" && BY_CODE.has(value);
}

export function isAppLanguagePreference(value: unknown): value is AppLanguagePreference {
  return value === APP_LANGUAGE_AUTO || isAppLanguageCode(value);
}

export function appLanguage(code: AppLanguageCode): AppLanguage {
  return BY_CODE.get(code)!;
}

/** Old or alternative language codes phones still report. */
const LEGACY_CODES: Record<string, string> = { iw: "he", in: "id", tl: "fil", no: "nb", nn: "nb" };
/** Where Portuguese is written the European way. */
const EUROPEAN_PORTUGUESE = new Set(["PT", "GW", "LU", "AO", "ST", "CH", "MZ", "CV", "GQ", "TL"]);
/** Where Chinese is written in traditional characters. */
const TRADITIONAL_CHINESE = new Set(["TW", "HK", "MO"]);

function parseTag(tag: string): { language: string; script: string | null; region: string | null } | null {
  const parts = tag.trim().replace(/_/g, "-").split("-").filter(Boolean);
  const language = parts[0]?.toLowerCase();
  if (!language || !/^[a-z]{2,3}$/.test(language)) return null;
  let script: string | null = null;
  let region: string | null = null;
  for (const part of parts.slice(1)) {
    if (!script && /^[A-Za-z]{4}$/.test(part)) script = part[0]!.toUpperCase() + part.slice(1).toLowerCase();
    else if (!region && /^([A-Za-z]{2}|\d{3})$/.test(part)) region = part.toUpperCase();
  }
  return { language: LEGACY_CODES[language] ?? language, script, region };
}

/** The Automa language for a locale tag ("es-MX" is "es", "zh-HK" is "zh-TW", "pt" is "pt-BR"), or null when Automa has none. */
export function matchAppLanguage(tag: string): AppLanguageCode | null {
  const parsed = parseTag(tag);
  if (!parsed) return null;
  const { language, script, region } = parsed;
  if (language === "zh") {
    return script === "Hant" || (!script && region && TRADITIONAL_CHINESE.has(region)) ? "zh-TW" : "zh-CN";
  }
  if (language === "pt") return region && EUROPEAN_PORTUGUESE.has(region) ? "pt-PT" : "pt-BR";
  return isAppLanguageCode(language) ? language : null;
}

/** The two-letter country of a locale tag ("en-JM" is "JM"), or null. */
export function countryFromLocale(tag: string): string | null {
  const region = parseTag(tag)?.region;
  return region && /^[A-Z]{2}$/.test(region) ? region : null;
}

/** The country an IANA time zone is in ("America/Jamaica" is "JM"), or null for zones like UTC. */
export function countryFromTimeZone(timeZone: string | null | undefined): string | null {
  return (timeZone && TIME_ZONE_COUNTRIES[timeZone]) || null;
}

export interface DetectedLanguage {
  /** The Automa language the device's languages point to (English when none matches). */
  language: AppLanguageCode;
  /** The device locale that matched ("es-MX"), for dates and numbers; null when none matched. */
  locale: string | null;
  /** Where the person is: the time zone's country, else the locale's region. */
  country: string | null;
  timeZone: string | null;
}

/**
 * What "Auto" means on this device: the first of its languages Automa has
 * (`navigator.languages`, most preferred first) and the country from its time
 * zone, or the locale's region when the time zone says nothing.
 */
export function detectAppLanguage(deviceLanguages: readonly string[], timeZone: string | null): DetectedLanguage {
  let language: AppLanguageCode = DEFAULT_APP_LANGUAGE;
  let locale: string | null = null;
  for (const tag of deviceLanguages) {
    const match = matchAppLanguage(tag);
    if (match) {
      language = match;
      locale = tag.trim().replace(/_/g, "-");
      break;
    }
  }
  const country = countryFromTimeZone(timeZone)
    ?? (locale ? countryFromLocale(locale) : null)
    ?? deviceLanguages.map(countryFromLocale).find((value): value is string => Boolean(value))
    ?? null;
  return { language, locale, country, timeZone: timeZone || null };
}

/** The language a saved choice means on this device: the chosen one, or what Auto detected. */
export function effectiveAppLanguage(preference: AppLanguagePreference | null | undefined, detected: DetectedLanguage): AppLanguageCode {
  return preference && preference !== APP_LANGUAGE_AUTO ? preference : detected.language;
}

/**
 * The locale dates and numbers are written in: the device's own locale when
 * it is in the chosen language ("es-MX"), else the chosen language in the
 * person's country when the platform knows that pairing ("fr" in Jamaica is
 * "fr-JM"), else the language alone.
 */
export function formattingLocale(language: AppLanguageCode, detected: DetectedLanguage): string {
  if (detected.locale && matchAppLanguage(detected.locale) === language) return detected.locale;
  // pt-BR, zh-TW…: the code already names its region.
  if (detected.country && !language.includes("-")) {
    const candidate = `${language}-${detected.country}`;
    try {
      if (Intl.DateTimeFormat.supportedLocalesOf([candidate]).length > 0) return candidate;
    } catch {
      // An invalid pairing: the language alone.
    }
  }
  return language;
}

/**
 * What an agent is told about the person it answers: their language in
 * English and in itself, and their country when known.
 */
export function describeReplyLanguage(language: AppLanguageCode, country: string | null): string {
  const entry = appLanguage(language);
  let where = "";
  if (country) {
    try {
      where = new Intl.DisplayNames(["en"], { type: "region" }).of(country) ?? country;
    } catch {
      where = country;
    }
  }
  const name = entry.name === entry.nativeName ? entry.name : `${entry.name} (${entry.nativeName})`;
  return where ? `${name}, in ${where}` : name;
}
