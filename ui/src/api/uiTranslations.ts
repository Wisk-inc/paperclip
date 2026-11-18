import type { AppLanguageCode } from "@paperclipai/shared";
import { api } from "./client";

export interface UiTranslationsResponse {
  language: AppLanguageCode;
  translations: Record<string, string>;
}

export interface UiTranslateResponse extends UiTranslationsResponse {
  /** Strings still without a translation (try again later). */
  pending: string[];
}

export const uiTranslationsApi = {
  /** Every translation of the board's text the server has saved for a language. */
  all: (language: AppLanguageCode) => api.get<UiTranslationsResponse>(`/ui-translations/${encodeURIComponent(language)}`),
  /** Translations of these board strings; the free models translate the ones the server has not seen yet. */
  translate: (language: AppLanguageCode, strings: string[]) =>
    api.post<UiTranslateResponse>("/ui-translations", { language, strings }),
};
