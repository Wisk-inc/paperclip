import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { userLanguagePreferences } from "@paperclipai/db";
import {
  APP_LANGUAGE_AUTO,
  describeReplyLanguage,
  isAppLanguageCode,
  isAppLanguagePreference,
  type AppLanguageCode,
  type LanguagePreference,
  type UpdateLanguagePreference,
} from "@paperclipai/shared";

type Row = typeof userLanguagePreferences.$inferSelect;

const NO_PREFERENCE: LanguagePreference = {
  language: APP_LANGUAGE_AUTO,
  detectedLanguage: null,
  detectedLocale: null,
  country: null,
  timeZone: null,
  updatedAt: null,
};

function toPreference(row: Row | null | undefined): LanguagePreference {
  if (!row) return { ...NO_PREFERENCE };
  return {
    // A code from a newer Automa this server does not know reads as Auto.
    language: isAppLanguagePreference(row.language) ? row.language : APP_LANGUAGE_AUTO,
    detectedLanguage: isAppLanguageCode(row.detectedLanguage) ? row.detectedLanguage : null,
    detectedLocale: row.detectedLocale ?? null,
    country: row.country ?? null,
    timeZone: row.timeZone ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/** The language an agent writes to a person in, and where they are. */
export interface ReplyLanguage {
  language: AppLanguageCode;
  country: string | null;
  timeZone: string | null;
}

/** The language a preference means for replies: the chosen one, or what Auto found on their device; null when unknown. */
export function replyLanguageOf(preference: LanguagePreference): ReplyLanguage | null {
  const language = preference.language !== APP_LANGUAGE_AUTO ? preference.language : preference.detectedLanguage;
  if (!language) return null;
  return { language, country: preference.country, timeZone: preference.timeZone };
}

/**
 * The note agents get about the person they answer. Their writing to the
 * person follows it; code, commands, names and quotes stay as they are, and a
 * person who writes in another language is answered in that one.
 */
export function replyLanguageNote(reply: ReplyLanguage): string {
  const described = describeReplyLanguage(reply.language, reply.country);
  const zone = reply.timeZone ? ` Their time zone is ${reply.timeZone}.` : "";
  const name = described.replace(/, in .*$/, "");
  return [
    `The person you are answering uses Automa in ${described}.${zone}`,
    `Write what you say to them (replies, comments, questions, summaries, task updates) in ${name}. If they write to you in another language, answer in that language. Keep code, commands, file names, identifiers and quoted text as they are.`,
  ].join(" ");
}

export function languagePreferenceService(db: Db) {
  return {
    async get(userId: string): Promise<LanguagePreference> {
      const row = await db.query.userLanguagePreferences.findFirst({
        where: eq(userLanguagePreferences.userId, userId),
      });
      return toPreference(row);
    },

    /** Saves the fields given; the rest stay as they were. */
    async update(userId: string, patch: UpdateLanguagePreference): Promise<LanguagePreference> {
      const now = new Date();
      const fields: Partial<typeof userLanguagePreferences.$inferInsert> = {};
      if (patch.language !== undefined) fields.language = patch.language;
      if (patch.detectedLanguage !== undefined) fields.detectedLanguage = patch.detectedLanguage;
      if (patch.detectedLocale !== undefined) fields.detectedLocale = patch.detectedLocale;
      if (patch.country !== undefined) fields.country = patch.country;
      if (patch.timeZone !== undefined) fields.timeZone = patch.timeZone;
      const [row] = await db
        .insert(userLanguagePreferences)
        .values({ userId, ...fields, updatedAt: now })
        .onConflictDoUpdate({
          target: [userLanguagePreferences.userId],
          set: { ...fields, updatedAt: now },
        })
        .returning();
      return toPreference(row);
    },

    /** The language an agent should write to this person in; null for no person or nothing known. */
    async replyLanguage(userId: string | null | undefined): Promise<ReplyLanguage | null> {
      if (!userId) return null;
      return replyLanguageOf(await this.get(userId));
    },
  };
}
