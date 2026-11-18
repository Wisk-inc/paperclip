import { z } from "zod";
import { APP_LANGUAGE_AUTO, APP_LANGUAGE_CODES } from "../app-languages.js";

const languageCodeSchema = z.enum(APP_LANGUAGE_CODES);
const languagePreferenceValueSchema = z.union([z.literal(APP_LANGUAGE_AUTO), languageCodeSchema]);
/** A BCP 47 locale tag as a device reports it ("es-MX", "zh-Hant-HK"). */
const localeTagSchema = z.string().trim().max(35).regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/);
/** An ISO 3166-1 alpha-2 country. */
const countrySchema = z.string().regex(/^[A-Z]{2}$/);
/** An IANA time zone name ("America/Argentina/Buenos_Aires", "Etc/GMT+5"). */
const timeZoneSchema = z.string().trim().max(64).regex(/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/);

export const languagePreferenceSchema = z.object({
  language: languagePreferenceValueSchema,
  detectedLanguage: languageCodeSchema.nullable(),
  detectedLocale: z.string().nullable(),
  country: z.string().nullable(),
  timeZone: z.string().nullable(),
  updatedAt: z.coerce.date().nullable(),
});

/** What the board sends: the choice, and what Auto found on this device. Fields left out stay as they are. */
export const updateLanguagePreferenceSchema = z
  .object({
    language: languagePreferenceValueSchema.optional(),
    detectedLanguage: languageCodeSchema.nullable().optional(),
    detectedLocale: localeTagSchema.nullable().optional(),
    country: countrySchema.nullable().optional(),
    timeZone: timeZoneSchema.nullable().optional(),
  })
  .strict();

export type UpdateLanguagePreference = z.infer<typeof updateLanguagePreferenceSchema>;
