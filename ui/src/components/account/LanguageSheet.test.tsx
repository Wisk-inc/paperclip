// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { APP_LANGUAGES, type AppLanguagePreference } from "@paperclipai/shared";
import type { LanguageContextValue } from "@/context/LanguageContext";

const language = vi.hoisted(() => ({ value: null as unknown as LanguageContextValue }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => language.value }));

import { LanguageSheet, countryNameIn, languageNameIn, preferenceLabel } from "./LanguageSheet";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let setPreference: Mock<(next: AppLanguagePreference) => void>;

function context(preference: AppLanguagePreference, overrides: Partial<LanguageContextValue> = {}): LanguageContextValue {
  return {
    preference,
    language: preference === "auto" ? "es" : preference,
    detected: { language: "es", locale: "es-MX", country: "MX", timeZone: "America/Mexico_City" },
    setPreference,
    unsynced: false,
    aiTranslation: true,
    ...overrides,
  };
}

async function show(value: LanguageContextValue) {
  language.value = value;
  await act(async () => root.render(<LanguageSheet open onOpenChange={vi.fn()} />));
}

const sheet = () => document.querySelector<HTMLElement>('[data-testid="language-sheet"]')!;
const option = (code: string) => document.querySelector<HTMLButtonElement>(`[data-testid="language-option-${code}"]`);
const options = () => Array.from(sheet().querySelectorAll<HTMLButtonElement>('[role="radio"]'));

async function search(text: string) {
  const input = document.querySelector<HTMLInputElement>('[data-testid="language-search"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  setPreference = vi.fn<(next: AppLanguagePreference) => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("LanguageSheet", () => {
  it("offers Auto and all 40 languages, each under its own name", async () => {
    await show(context("auto"));
    expect(options()).toHaveLength(41);
    expect(APP_LANGUAGES).toHaveLength(40);
    for (const entry of APP_LANGUAGES) {
      expect(option(entry.code)?.textContent).toContain(entry.nativeName);
    }
    // Auto names what this device asks for, and where it is.
    expect(option("auto")?.textContent).toContain("Auto");
    expect(option("auto")?.textContent).toContain("Follows this device: Español (México)");
    expect(option("auto")?.getAttribute("aria-checked")).toBe("true");
  });

  it("names each language in the language the screens are in, and never translates its own name", async () => {
    await show(context("auto"));
    // The screens are in Spanish: German reads "alemán" under "Deutsch".
    expect(option("de")?.textContent).toContain("Deutsch");
    expect(option("de")?.textContent?.toLowerCase()).toContain("alemán");
    const nativeName = option("de")!.querySelector("span span")!;
    expect(nativeName.getAttribute("translate")).toBe("no");
  });

  it("marks the chosen language and saves a new choice", async () => {
    await show(context("ja"));
    expect(option("ja")?.getAttribute("aria-checked")).toBe("true");
    expect(option("auto")?.getAttribute("aria-checked")).toBe("false");
    await act(async () => option("sw")!.click());
    expect(setPreference).toHaveBeenCalledWith("sw");
    await act(async () => option("auto")!.click());
    expect(setPreference).toHaveBeenLastCalledWith("auto");
  });

  it("finds languages by their own name, English name or code, accents optional", async () => {
    await show(context("auto", { language: "en" }));
    await search("espanol");
    expect(options().map((button) => button.dataset.testid)).toEqual(["language-option-es"]);
    await search("chinese");
    expect(options().map((button) => button.dataset.testid)).toEqual(["language-option-zh-CN", "language-option-zh-TW"]);
    await search("pt-");
    expect(options().map((button) => button.dataset.testid)).toEqual(["language-option-pt-BR", "language-option-pt-PT"]);
    await search("klingon");
    expect(options()).toHaveLength(0);
    expect(document.querySelector('[data-testid="language-none"]')).not.toBeNull();
  });

  it("explains AI translation and privacy, and when the choice is only on this device", async () => {
    await show(context("fr", { unsynced: true }));
    expect(sheet().textContent).toContain("Only Automa’s own words are sent, never your chats, tasks or names.");
    expect(document.querySelector('[data-testid="language-unsynced"]')?.textContent).toContain("Saved on this device.");
    await show(context("fr", { aiTranslation: false }));
    expect(sheet().textContent).toContain("Sign in and the rest of Automa is translated too.");
  });
});

describe("names", () => {
  it("names languages and countries in a given language, with fallbacks", () => {
    expect(languageNameIn("de", "en")).toBe("German");
    expect(languageNameIn("zh-TW", "en")).toBe("Traditional Chinese");
    expect(countryNameIn("JM", "es")).toBe("Jamaica");
    expect(countryNameIn(null, "es")).toBeNull();
    expect(preferenceLabel("auto", { language: "fr", country: "HT" })).toBe("Français (Haïti)");
    expect(preferenceLabel("pt-BR", { language: "fr", country: "HT" })).toBe("Português (Brasil)");
  });
});
