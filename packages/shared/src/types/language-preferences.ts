import type { AppLanguageCode, AppLanguagePreference } from "../app-languages.js";

/** A person's language for Automa's screens and for what agents write to them. */
export interface LanguagePreference {
  /** "auto", or the language they chose. */
  language: AppLanguagePreference;
  /** With "auto": the language their device asked for, as of its last report. */
  detectedLanguage: AppLanguageCode | null;
  /** The device's locale ("es-MX"). */
  detectedLocale: string | null;
  /** Their country (two letters), from the device's time zone or region. */
  country: string | null;
  timeZone: string | null;
  updatedAt: Date | null;
}
