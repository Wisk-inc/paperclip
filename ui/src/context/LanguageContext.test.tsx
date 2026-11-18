// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguagePreference, UpdateLanguagePreference } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { formatLocale } from "@/i18n/format-locale";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  all: vi.fn(),
  translate: vi.fn(),
  builtin: vi.fn(),
}));
vi.mock("@/api/languagePreferences", () => ({ languagePreferencesApi: { get: api.get, update: api.update } }));
vi.mock("@/api/uiTranslations", () => ({ uiTranslationsApi: { all: api.all, translate: api.translate } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn(async () => null) } }));
vi.mock("@/i18n/builtin-translations", () => ({ loadBuiltinTranslations: api.builtin }));
vi.mock("@/i18n/ui-string-index", async (original) => {
  const actual = await original<typeof import("@/i18n/ui-string-index")>();
  return { ...actual, loadUiStringIndex: async () => actual.buildUiStringIndex(["Sign out", "Settings"]) };
});

import {
  LANGUAGE_STORAGE_KEY,
  LANGUAGE_UNSYNCED_KEY,
  LanguageProvider,
  deviceReport,
  reportDiffers,
  useLanguage,
  type LanguageContextValue,
} from "./LanguageContext";
import { i18n } from "@/i18n";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let current: LanguageContextValue;

function saved(language: LanguagePreference["language"], extra: Partial<LanguagePreference> = {}): LanguagePreference {
  return {
    language,
    detectedLanguage: "es",
    detectedLocale: "es-MX",
    country: "MX",
    timeZone: "America/Mexico_City",
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...extra,
  };
}

function device(languages: string[], timeZone: string) {
  Object.defineProperty(window.navigator, "languages", { value: languages, configurable: true });
  Object.defineProperty(window.navigator, "language", { value: languages[0], configurable: true });
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone };
  });
}

function Probe() {
  current = useLanguage();
  return <p>Sign out</p>;
}

async function show() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LanguageProvider>
          <Probe />
        </LanguageProvider>
      </QueryClientProvider>,
    ),
  );
}

function signIn() {
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-1", name: "Ana", email: null }, session: { id: "s", userId: "user-1" } });
}

async function settle() {
  await act(async () => {
    for (let n = 0; n < 5; n += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  device(["es-MX", "en-US"], "America/Mexico_City");
  api.get.mockReset().mockResolvedValue(saved("auto"));
  api.update.mockReset().mockImplementation(async (patch: UpdateLanguagePreference) => ({ ...saved("auto"), ...patch }));
  api.all.mockReset().mockResolvedValue({ language: "es", translations: {} });
  api.translate.mockReset().mockResolvedValue({ language: "es", translations: {}, pending: [] });
  api.builtin.mockReset().mockResolvedValue({ "Sign out": "Cerrar sesión" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
});

describe("LanguageProvider", () => {
  it("Auto follows the device: its language, and dates in its locale", async () => {
    await show();
    expect(current.preference).toBe("auto");
    expect(current.language).toBe("es");
    expect(current.detected).toMatchObject({ language: "es", locale: "es-MX", country: "MX", timeZone: "America/Mexico_City" });
    expect(document.documentElement.lang).toBe("es");
    expect(document.documentElement.dir).toBe("ltr");
    expect(formatLocale()).toBe("es-MX");
    expect(i18n.language).toBe("es");
  });

  it("puts the screens in the language: the board's words are translated on the page", async () => {
    await show();
    await settle();
    expect(container.textContent).toBe("Cerrar sesión");
    expect(api.builtin).toHaveBeenCalledWith("es");
  });

  it("writes right to left for Arabic, and back for English", async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "ar");
    await show();
    expect(current.language).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    await act(async () => current.setPreference("en"));
    await settle();
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
    // English: the original words, untouched.
    expect(container.textContent).toBe("Sign out");
  });

  it("a choice made on another device is followed here", async () => {
    api.get.mockResolvedValue(saved("fr"));
    signIn();
    await show();
    await settle();
    expect(current.preference).toBe("fr");
    expect(current.language).toBe("fr");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("fr");
    expect(api.update).not.toHaveBeenCalled();
  });

  it("a choice made here before it reached the account goes there, instead of being replaced", async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "de");
    localStorage.setItem(LANGUAGE_UNSYNCED_KEY, "1");
    api.get.mockResolvedValue(saved("fr"));
    signIn();
    await show();
    await settle();
    expect(current.preference).toBe("de");
    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ language: "de", detectedLanguage: "es", country: "MX" }));
    expect(localStorage.getItem(LANGUAGE_UNSYNCED_KEY)).toBeNull();
    expect(current.unsynced).toBe(false);
  });

  it("tells the account what this device found when it changed", async () => {
    api.get.mockResolvedValue(saved("auto", { country: "US", timeZone: "America/New_York", detectedLocale: "en-US", detectedLanguage: "en" }));
    signIn();
    await show();
    await settle();
    expect(api.update).toHaveBeenCalledWith({
      detectedLanguage: "es",
      detectedLocale: "es-MX",
      country: "MX",
      timeZone: "America/Mexico_City",
    });
  });

  it("saves a choice to the account; the latest tap wins when answers come back out of order", async () => {
    signIn();
    await show();
    await settle();
    api.update.mockClear();
    let answerSpanish: (value: LanguagePreference) => void = () => undefined;
    api.update
      .mockImplementationOnce(() => new Promise<LanguagePreference>((resolve) => { answerSpanish = resolve; }))
      .mockImplementationOnce(async () => saved("fr"));
    await act(async () => current.setPreference("es"));
    await act(async () => current.setPreference("fr"));
    await settle();
    await act(async () => answerSpanish(saved("es")));
    await settle();
    expect(current.preference).toBe("fr");
    expect(client.getQueryData<LanguagePreference>(queryKeys.languagePreferences.mine("user-1"))?.language).toBe("fr");
    expect(localStorage.getItem(LANGUAGE_UNSYNCED_KEY)).toBeNull();
  });

  it("keeps the choice on the device and says so when the account can't be reached", async () => {
    signIn();
    await show();
    await settle();
    api.update.mockRejectedValueOnce(new Error("offline"));
    await act(async () => current.setPreference("it"));
    await settle();
    expect(current.language).toBe("it");
    expect(current.unsynced).toBe(true);
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("it");
    expect(localStorage.getItem(LANGUAGE_UNSYNCED_KEY)).toBe("1");
  });

  it("signed out: the choice stays on this device and no account is asked", async () => {
    await show();
    await act(async () => current.setPreference("pt-BR"));
    await settle();
    expect(current.language).toBe("pt-BR");
    expect(current.unsynced).toBe(true);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
    expect(api.translate).not.toHaveBeenCalled();
  });
});

describe("deviceReport", () => {
  it("leaves out values the server would refuse", () => {
    expect(deviceReport({ language: "es", locale: "es_MX!!", country: "mx", timeZone: "Not a zone!" })).toEqual({ detectedLanguage: "es" });
    expect(reportDiffers(saved("auto"), { detectedLanguage: "es" })).toBe(false);
    expect(reportDiffers(saved("auto"), { detectedLanguage: "es", country: "JM" })).toBe(true);
  });
});

describe("useLanguage outside the provider", () => {
  it("reads as Auto in English, and choosing changes nothing", async () => {
    await act(async () => root.render(<Probe />));
    expect(current.preference).toBe("auto");
    expect(current.language).toBe("en");
    expect(() => current.setPreference("es")).not.toThrow();
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
    expect(container.textContent).toBe("Sign out");
  });
});
