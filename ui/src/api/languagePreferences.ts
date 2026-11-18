import type { LanguagePreference, UpdateLanguagePreference } from "@paperclipai/shared";
import { api } from "./client";

export const languagePreferencesApi = {
  /** The signed-in person's language: Auto or one they chose, and what Auto found on their device. */
  get: () => api.get<LanguagePreference>("/language-preferences/me"),
  /** Saves the fields given (the choice, or this device's detection); the rest stay. */
  update: (patch: UpdateLanguagePreference) => api.put<LanguagePreference>("/language-preferences/me", patch),
};
