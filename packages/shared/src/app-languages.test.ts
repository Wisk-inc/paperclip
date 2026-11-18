import { describe, expect, it } from "vitest";
import {
  APP_LANGUAGES,
  APP_LANGUAGE_CODES,
  countryFromLocale,
  countryFromTimeZone,
  describeReplyLanguage,
  detectAppLanguage,
  effectiveAppLanguage,
  formattingLocale,
  isAppLanguagePreference,
  matchAppLanguage,
} from "./app-languages.js";

describe("the language list", () => {
  it("has the forty languages, each once, with its own name and direction", () => {
    expect(APP_LANGUAGES).toHaveLength(40);
    expect(APP_LANGUAGES.map((language) => language.code)).toEqual([...APP_LANGUAGE_CODES]);
    expect(APP_LANGUAGES.filter((language) => language.rtl).map((language) => language.code)).toEqual(["ar", "fa", "he", "ur"]);
    for (const language of APP_LANGUAGES) expect(language.nativeName.trim(), language.code).not.toBe("");
    expect(isAppLanguagePreference("auto")).toBe(true);
    expect(isAppLanguagePreference("pt-BR")).toBe(true);
    expect(isAppLanguagePreference("pt")).toBe(false);
    expect(isAppLanguagePreference("klingon")).toBe(false);
  });
});

describe("matchAppLanguage", () => {
  it("takes the language from a locale and its region where the writing differs", () => {
    expect(matchAppLanguage("es-MX")).toBe("es");
    expect(matchAppLanguage("en_JM")).toBe("en");
    expect(matchAppLanguage("fr")).toBe("fr");
    expect(matchAppLanguage("pt")).toBe("pt-BR");
    expect(matchAppLanguage("pt-BR")).toBe("pt-BR");
    expect(matchAppLanguage("pt-PT")).toBe("pt-PT");
    expect(matchAppLanguage("pt-AO")).toBe("pt-PT");
    expect(matchAppLanguage("zh")).toBe("zh-CN");
    expect(matchAppLanguage("zh-SG")).toBe("zh-CN");
    expect(matchAppLanguage("zh-HK")).toBe("zh-TW");
    expect(matchAppLanguage("zh-Hant")).toBe("zh-TW");
    expect(matchAppLanguage("zh-Hans-HK")).toBe("zh-CN");
  });

  it("reads the old codes phones still send, and says null for languages Automa does not have", () => {
    expect(matchAppLanguage("iw-IL")).toBe("he");
    expect(matchAppLanguage("in-ID")).toBe("id");
    expect(matchAppLanguage("tl-PH")).toBe("fil");
    expect(matchAppLanguage("no")).toBe("nb");
    expect(matchAppLanguage("nn-NO")).toBe("nb");
    expect(matchAppLanguage("ht-HT")).toBeNull();
    expect(matchAppLanguage("")).toBeNull();
    expect(matchAppLanguage("not a tag")).toBeNull();
  });
});

describe("countries", () => {
  it("from a locale's region and from a time zone, old names included", () => {
    expect(countryFromLocale("en-JM")).toBe("JM");
    expect(countryFromLocale("es-419")).toBeNull();
    expect(countryFromLocale("fr")).toBeNull();
    expect(countryFromTimeZone("America/Jamaica")).toBe("JM");
    expect(countryFromTimeZone("Jamaica")).toBe("JM");
    expect(countryFromTimeZone("Asia/Calcutta")).toBe("IN");
    expect(countryFromTimeZone("UTC")).toBeNull();
    expect(countryFromTimeZone(null)).toBeNull();
  });
});

describe("detectAppLanguage", () => {
  it("takes the first language Automa has and the country from the time zone", () => {
    expect(detectAppLanguage(["ht-HT", "fr-HT", "en-US"], "America/Port-au-Prince")).toEqual({
      language: "fr",
      locale: "fr-HT",
      country: "HT",
      timeZone: "America/Port-au-Prince",
    });
    // A phone set to US English in Jamaica: English, and Jamaica from the time zone.
    expect(detectAppLanguage(["en-US"], "America/Jamaica")).toMatchObject({ language: "en", locale: "en-US", country: "JM" });
  });

  it("falls back to the locale's region without a known time zone, and to English with no match", () => {
    expect(detectAppLanguage(["es-MX"], "UTC")).toMatchObject({ language: "es", country: "MX" });
    expect(detectAppLanguage(["ht-HT"], null)).toEqual({ language: "en", locale: null, country: "HT", timeZone: null });
    expect(detectAppLanguage([], null)).toEqual({ language: "en", locale: null, country: null, timeZone: null });
  });
});

describe("the language in use and its formatting", () => {
  const mexico = detectAppLanguage(["es-MX", "en"], "America/Mexico_City");

  it("is the chosen one, or Auto's", () => {
    expect(effectiveAppLanguage("auto", mexico)).toBe("es");
    expect(effectiveAppLanguage(null, mexico)).toBe("es");
    expect(effectiveAppLanguage("ja", mexico)).toBe("ja");
  });

  it("writes dates and numbers the device's way, or the chosen language's way in the person's country", () => {
    expect(formattingLocale("es", mexico)).toBe("es-MX");
    expect(formattingLocale("fr", mexico)).toBe("fr-MX");
    expect(formattingLocale("pt-BR", mexico)).toBe("pt-BR");
    expect(formattingLocale("de", detectAppLanguage([], null))).toBe("de");
  });

  it("tells an agent the language by name and the country", () => {
    expect(describeReplyLanguage("es", "MX")).toBe("Spanish (Español), in Mexico");
    expect(describeReplyLanguage("en", "JM")).toBe("English, in Jamaica");
    expect(describeReplyLanguage("ja", null)).toBe("Japanese (日本語)");
  });
});
