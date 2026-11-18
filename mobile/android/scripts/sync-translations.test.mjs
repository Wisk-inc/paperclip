import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import {
  ANDROID_QUALIFIERS,
  ANDROID_ROOT,
  LANGUAGES,
  RTL_LANGUAGES,
  androidStrings,
  connectDictionary,
  connectStrings,
  escapeAndroid,
  outputs,
  readSource,
  renderAndroid,
  rtlParagraph,
  strays,
} from "./sync-translations.mjs";

const REPO_ROOT = path.resolve(ANDROID_ROOT, "../..");
const read = (relative) => readFileSync(path.join(REPO_ROOT, relative), "utf8");
/** Words a person reads: placeholders ("%1$d", "{0}") are not words. */
const words = (text) => text.replace(/%\d+\$[0-9]*[sd]|\{\d+\}/g, " ").split(/\s+/).filter(Boolean).length;
const androidArgs = (text) => (text.match(/%\d+\$[0-9]*[sd]/g) ?? []).sort();
const braces = (text) => (text.match(/\{\d+\}/g) ?? []).sort();

/** What every long sentence of a language must be written in. */
const SCRIPT = {
  ar: /\p{Script=Arabic}/u, bn: /\p{Script=Bengali}/u, el: /\p{Script=Greek}/u, fa: /\p{Script=Arabic}/u,
  he: /\p{Script=Hebrew}/u, hi: /\p{Script=Devanagari}/u, ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  ko: /\p{Script=Hangul}/u, mr: /\p{Script=Devanagari}/u, pa: /\p{Script=Gurmukhi}/u, ru: /\p{Script=Cyrillic}/u,
  ta: /\p{Script=Tamil}/u, te: /\p{Script=Telugu}/u, th: /\p{Script=Thai}/u, uk: /\p{Script=Cyrillic}/u,
  ur: /\p{Script=Arabic}/u, "zh-CN": /\p{Script=Han}/u, "zh-TW": /\p{Script=Han}/u,
};

test("every list of Automa's languages is the same", () => {
  const shared = [...read("packages/shared/src/app-languages.ts").match(/APP_LANGUAGE_CODES = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const kotlin = [...read("mobile/android/app/src/main/java/com/corxlabs/automa/AppLanguage.kt").match(/CODES: Set<String> = setOf\(([\s\S]*?)\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const connect = [...read("mobile/android/app/src/main/assets/connect/i18n.js").match(/var CODES = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const localeConfig = [...read("mobile/android/app/src/main/res/xml/locales_config.xml").matchAll(/android:name="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(shared.length, 40);
  assert.deepEqual(kotlin, shared);
  assert.deepEqual(connect, shared);
  assert.deepEqual(localeConfig, shared);
  assert.deepEqual([...LANGUAGES].sort(), shared.filter((code) => code !== "en").sort());
});

test("the connect screen's words are on the screen exactly as listed", () => {
  const page = read("mobile/android/app/src/main/assets/connect/index.html") + read("mobile/android/app/src/main/assets/connect/connect.js");
  const flat = page.replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ");
  for (const source of connectStrings()) {
    const probe = source.split("{0}")[0].trim();
    assert.ok(flat.includes(probe), source);
  }
});

for (const language of LANGUAGES) {
  test(`${language}: the connect screen and the app's own words are all translated`, () => {
    const source = readSource(language);
    const connect = connectDictionary(language);
    const listed = connectStrings();
    assert.deepEqual(listed.filter((text) => !(text in connect)), [], "connect strings without a translation");
    assert.deepEqual(Object.keys(source.connect ?? {}).filter((text) => !listed.includes(text)), [], "connect translations not on the list");
    for (const [english, text] of Object.entries(connect)) {
      assert.equal(text, text.trim(), english);
      assert.deepEqual(braces(text), braces(english), english);
      if (words(english) >= 4) {
        assert.notEqual(text, english, english);
        if (SCRIPT[language]) assert.match(text, SCRIPT[language], `${english} → ${text}`);
      }
    }

    const english = androidStrings();
    assert.deepEqual(Object.keys(source.android ?? {}).sort(), Object.keys(english).sort(), "android strings");
    for (const [name, text] of Object.entries(source.android)) {
      assert.equal(typeof text, "string", name);
      assert.ok(text.trim(), name);
      assert.deepEqual(androidArgs(text), androidArgs(english[name]), `${name}: ${text}`);
      if (words(english[name]) >= 4) {
        assert.notEqual(text, english[name], name);
        if (SCRIPT[language]) assert.match(text, SCRIPT[language], `${name} → ${text}`);
      }
      if (/\bAutoma\b/.test(english[name])) assert.match(text, /Autom[aá]/, name);
    }
  });
}

test("Android resource text is escaped and every language has its folders", () => {
  assert.equal(escapeAndroid("Couldn't save \"x\" & <y>"), "Couldn\\'t save \\\"x\\\" &amp; &lt;y&gt;");
  assert.equal(escapeAndroid("@home"), "\\@home");
  assert.equal(escapeAndroid("?"), "\\?");
  assert.deepEqual(ANDROID_QUALIFIERS.he, ["iw"]);
  assert.deepEqual(ANDROID_QUALIFIERS.id, ["in"]);
});

test("a right-to-left line that starts with a Latin word or a file name is marked right to left", () => {
  const RLM = "‏";
  assert.equal(rtlParagraph("Automa شروع ہو رہا ہے"), `${RLM}Automa شروع ہو رہا ہے`);
  assert.equal(rtlParagraph("Automa 1.0 עדיין מותקן"), `${RLM}Automa 1.0 עדיין מותקן`);
  // %1$s is a file name or a host, usually Latin.
  assert.equal(rtlParagraph("%1$s در پوشه ذخیره شد"), `${RLM}%1$s در پوشه ذخیره شد`);
  // Already starts with a right-to-left word, or only numbers come first.
  assert.equal(rtlParagraph("فائل %1$s محفوظ نہیں ہو سکی"), "فائل %1$s محفوظ نہیں ہو سکی");
  assert.equal(rtlParagraph("%1$d د %2$02d ث"), "%1$d د %2$02d ث");
  assert.equal(rtlParagraph("השרת לא ענה."), "השרת לא ענה.");
  // No right-to-left letters at all: left as written.
  assert.equal(rtlParagraph("App Studio"), "App Studio");
  assert.equal(rtlParagraph("Automa"), "Automa");
});

/** The <string> values a rendered strings.xml holds, still escaped. */
const renderedValues = (xml) => [...xml.matchAll(/<string name="([^"]+)">([\s\S]*?)<\/string>/g)].map((m) => [m[1], m[2]]);

test("every right-to-left app line reads right to left on Android, and only those carry the mark", () => {
  const firstStrong = (text) => {
    const stripped = text.replace(/%\d+\$[0-9]*d/g, "");
    for (const char of stripped) {
      if (char === "‏" || /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(char)) return "rtl";
      if (/\p{L}/u.test(char) || char === "%") return "ltr";
    }
    return "none";
  };
  for (const language of LANGUAGES) {
    for (const [name, value] of renderedValues(renderAndroid(language))) {
      if (!RTL_LANGUAGES.includes(language)) {
        assert.ok(!value.includes("‏"), `${language} ${name}`);
        continue;
      }
      if (!/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(value)) continue;
      assert.equal(firstStrong(value), "rtl", `${language} ${name}: ${value}`);
    }
  }
  // The launcher name stays exactly "Automa".
  for (const language of RTL_LANGUAGES) {
    assert.ok(renderAndroid(language).includes('<string name="app_name">Automa</string>'), language);
  }
});

test("the written files are up to date (pnpm i18n:android)", () => {
  for (const { file, content } of outputs()) {
    assert.ok(existsSync(file), path.relative(REPO_ROOT, file));
    assert.equal(readFileSync(file, "utf8"), content, path.relative(REPO_ROOT, file));
  }
  assert.deepEqual(strays(), []);
});

/** Runs the connect screen's i18n.js against a phone's languages and the app's saved choice. */
function connectLanguage({ languages, saved, bridge = true }) {
  const root = { lang: "", dir: "", classList: { add() {}, remove() {} } };
  const context = {
    window: {},
    navigator: { languages, language: languages[0] },
    document: { documentElement: root, readyState: "complete", addEventListener() {}, body: null },
    fetch: () => new Promise(() => {}),
    setTimeout: () => 0,
    clearTimeout() {},
  };
  if (bridge) {
    context.window.__automaKey = "key";
    context.window.AutomaNative = { getLanguage: (key) => (key === "key" ? saved : "auto") };
  }
  vm.runInNewContext(read("mobile/android/app/src/main/assets/connect/i18n.js"), context);
  return { lang: root.lang, dir: root.dir };
}

test("the connect screen follows the board's choice, else the phone's languages", () => {
  assert.deepEqual(connectLanguage({ languages: ["en-US"], saved: "fr" }), { lang: "fr", dir: "ltr" });
  assert.deepEqual(connectLanguage({ languages: ["fr-FR"], saved: "ar" }), { lang: "ar", dir: "rtl" });
  assert.deepEqual(connectLanguage({ languages: ["de-AT", "en"], saved: "auto" }), { lang: "de", dir: "ltr" });
  assert.deepEqual(connectLanguage({ languages: ["zh-HK"], saved: "auto" }), { lang: "zh-TW", dir: "ltr" });
  assert.deepEqual(connectLanguage({ languages: ["pt-AO"], saved: "auto" }), { lang: "pt-PT", dir: "ltr" });
  assert.deepEqual(connectLanguage({ languages: ["iw-IL"], saved: "auto" }), { lang: "he", dir: "rtl" });
  assert.deepEqual(connectLanguage({ languages: ["xx-YY", "es-MX"], saved: "auto" }), { lang: "es", dir: "ltr" });
  assert.deepEqual(connectLanguage({ languages: ["xx"], saved: "auto" }), { lang: "en", dir: "ltr" });
  // An app before 1.9.14 has no getLanguage: Auto.
  assert.deepEqual(connectLanguage({ languages: ["ja-JP"], saved: "fr", bridge: false }), { lang: "ja", dir: "ltr" });
  // A value the app should never send is ignored.
  assert.deepEqual(connectLanguage({ languages: ["it-IT"], saved: "klingon" }), { lang: "it", dir: "ltr" });
});
