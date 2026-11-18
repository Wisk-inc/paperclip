import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Each person's language for Automa's screens and for what agents write to
 * them. Instance-wide, like the sidebar's company order: a person keeps one
 * language across every organization.
 *
 * `language` is "auto" or a language code (APP_LANGUAGE_CODES). With "auto"
 * the board reports what the person's device asked for: `detected_language`
 * (the Automa language it matched), `detected_locale` ("es-MX"), `country`
 * (two letters, from the device's time zone or region) and `time_zone`.
 */
export const userLanguagePreferences = pgTable(
  "user_language_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    language: text("language").notNull().default("auto"),
    detectedLanguage: text("detected_language"),
    detectedLocale: text("detected_locale"),
    country: text("country"),
    timeZone: text("time_zone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUq: uniqueIndex("user_language_preferences_user_uq").on(table.userId),
  }),
);
