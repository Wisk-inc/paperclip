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
  startupSteps,
  stepInSentence,
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

const CONNECT = "mobile/android/app/src/main/assets/connect";
const KOTLIN = "mobile/android/app/src/main/java/com/corxlabs/automa";
/** The app's Kotlin that writes words the connect screen or the board shows. */
const KOTLIN_FILES = ["AutomaBridge.kt", "MainActivity.kt", "ServerConfig.kt", "GoogleSignIn.kt"].map((name) => `${KOTLIN}/${name}`);

/** A listed sentence's own words: the parts between its values. */
const fixedParts = (text) => text.split(/\{\d+\}/).map((part) => part.trim()).filter(Boolean);
/** Whether all of `parts` are in `haystack`, in order. */
function inOrder(haystack, parts) {
  let at = 0;
  for (const part of parts) {
    const found = haystack.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
}
/** HTML as it reads: tags out (the words in their placeholder, title, aria-label and alt kept), entities decoded, spaces collapsed. */
const pageText = (html) => html
  .replace(/<[^>]+>/g, (tag) => ` ${[...tag.matchAll(/\b(?:placeholder|title|aria-label|alt)="([^"]*)"/g)].map((m) => m[1]).join(" ")} `)
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ");
/**
 * A Kotlin string starting at `at` (its opening quote): its text with each
 * value ($host, ${…}) as {0}, {1}…, joined with the strings it is added to
 * ("…" + "…", "…" + hint + "…"), and where it ends. Strings inside a ${…} are
 * kept apart, in `inner`.
 */
function kotlinString(source, at, inner = []) {
  let text = "";
  let values = 0;
  let i = at + 1;
  const skipBlock = (from) => {
    let depth = 1;
    let j = from;
    while (j < source.length && depth > 0) {
      if (source[j] === '"') {
        const nested = kotlinString(source, j, inner);
        inner.push(nested.text);
        j = nested.end;
        continue;
      }
      if (source[j] === "{") depth += 1;
      else if (source[j] === "}") depth -= 1;
      j += 1;
    }
    return j;
  };
  for (;;) {
    while (i < source.length && source[i] !== '"') {
      if (source[i] === "\\") {
        text += source[i + 1] === "n" ? "\n" : source[i + 1];
        i += 2;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        i = skipBlock(i + 2);
        text += `{${values++}}`;
      } else if (source[i] === "$" && /[A-Za-z_]/.test(source[i + 1] ?? "")) {
        i += 1;
        while (/[A-Za-z0-9_]/.test(source[i] ?? "")) i += 1;
        text += `{${values++}}`;
      } else {
        text += source[i];
        i += 1;
      }
    }
    i += 1;
    // Added to another string, or to a value and then a string.
    const rest = source.slice(i, i + 200);
    const literal = /^\s*\+\s*"/.exec(rest);
    const value = /^\s*\+\s*[A-Za-z_][\w.?()]*\s*\+\s*"/.exec(rest);
    if (literal) {
      i += literal[0].length;
    } else if (value) {
      text += `{${values++}}`;
      i += value[0].length;
    } else {
      return { text, end: i };
    }
  }
}
/** Every string in a Kotlin file (comments skipped), with the strings inside their values. */
function kotlinLiterals(source) {
  const out = [];
  for (let i = 0; i < source.length; ) {
    if (source.startsWith("//", i)) { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (source.startsWith("/*", i)) { i = source.indexOf("*/", i + 2) + 2; continue; }
    if (source.startsWith('"""', i)) { i = source.indexOf('"""', i + 3) + 3; continue; }
    if (source[i] === "'") { i += source[i + 1] === "\\" ? 4 : 3; continue; }
    if (source[i] === '"') {
      const inner = [];
      const found = kotlinString(source, i, inner);
      out.push(found.text, ...inner);
      i = found.end;
      continue;
    }
    i += 1;
  }
  return out;
}
/** The Kotlin string whose opening quote is at `at`. */
const kotlinAt = (source, at) => kotlinString(source, at).text;

/** A listed sentence as the connect screen's translator matches it: values may be anything, or nothing. */
function listedPattern(entry) {
  const parts = entry.split(/\{\d+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[\\s\\S]*?")}$`);
}
/** Whether a message the app writes is a listed sentence: as the translator would match it, or (a part of it) word for word. */
function onList(listed, message) {
  const sample = message.replace(/\{\d+\}/g, "example.local");
  return listed.some((entry) => listedPattern(entry).test(sample) || inOrder(entry, fixedParts(message)));
}

test("every connect screen string is still written by the page, its script or the app", () => {
  const page = pageText(read(`${CONNECT}/index.html`));
  const script = read(`${CONNECT}/connect.js`).replace(/\\u2011/g, "‑").replace(/\s+/g, " ");
  const kotlin = KOTLIN_FILES.flatMap((file) => kotlinLiterals(read(file))).join(" ");
  const kotlinWords = new Set(kotlin.toLowerCase().match(/[a-z][a-z'-]+/g));
  const stale = connectStrings().filter((text) => {
    if ([page, script, kotlin].some((haystack) => inOrder(haystack, fixedParts(text)))) return false;
    // A message the app puts together from parts ("file" + " is" / "s are"): its words are all still there.
    return !(text.toLowerCase().match(/[a-z][a-z'-]+/g) ?? []).every((word) => kotlinWords.has(word));
  });
  assert.deepEqual(stale, []);
});

/** Every list the app's words are on: the connect screen's, and the board's (for errors the app answers the board with). */
function listedAnywhere() {
  const board = [...read("ui/src/lib/automa-native.ts").match(/NATIVE_ERRORS = \[([\s\S]*?)\] as const/)[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"'));
  return { connect: connectStrings(), board };
}

test("every message the app sends the connect screen or the board is on a list", () => {
  const { connect, board } = listedAnywhere();
  const listed = [...connect, ...board];
  const missing = [];
  const termuxMessages = [];
  for (const file of KOTLIN_FILES) {
    const source = read(file);
    // What the app answers with (error(…), termuxFailure(…, …), put("error", …)), what the
    // connect screen is opened with (showConnect(…)), and ServerConfig.explain's sentences.
    const patterns = [
      /\berror\(\s*(?=")/g,
      /termuxFailure\(\s*"[^"]*",\s*(?=")/g,
      /put\("error",\s*(?=")/g,
      /showConnect\(\s*(?=")/g,
      /(?:const val LOCKED_WITHOUT_KEY = |return |-> )(?=")/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const message = kotlinAt(source, match.index + match[0].length);
        if (!/[A-Za-z]{3,} [A-Za-z]/.test(message)) continue;
        if (pattern.source.startsWith("termuxFailure")) termuxMessages.push(message);
        if (!onList(listed, message)) missing.push(`${path.basename(file)}: ${message}`);
      }
    }
  }
  assert.deepEqual(missing, []);
  // What Termux answers can show on either screen: it is on both lists.
  assert.ok(termuxMessages.length >= 6);
  for (const message of termuxMessages) {
    assert.ok(onList(board, message), `not on the board's list: ${message}`);
    assert.ok(onList(connect, message), `not on the connect screen's list: ${message}`);
  }
  // And nothing on the board's list that the app no longer sends.
  const kotlin = KOTLIN_FILES.flatMap((file) => kotlinLiterals(read(file)));
  assert.deepEqual(board.filter((entry) => !kotlin.some((literal) => onList([entry], literal))), []);
});

/** Strings in connect.js that are code or are not shown, though they read like words. */
const CONNECT_JS_NOT_SHOWN = new Set([
  "automa keep-alive",
  "Run: ",
  "HTTPS",
]);

test("every word connect.js shows is on the list", () => {
  const listed = connectStrings();
  const script = read(`${CONNECT}/connect.js`).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  const missing = [];
  for (const match of script.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    const text = match[1].replace(/\\u2011/g, "\u2011").replace(/\\"/g, '"');
    // Words for people: a capital and a space, or a label ending in "…"; not ids, selectors or code.
    if (!/^[A-Z][^#.=<>{}]*\s\S|…$|^[A-Z][a-z]+ $/.test(text) || CONNECT_JS_NOT_SHOWN.has(text)) continue;
    if (!listed.some((entry) => inOrder(entry, fixedParts(text)))) missing.push(text);
  }
  assert.deepEqual(missing, []);
});

test("the startup steps are the ones the server names", () => {
  const server = read("server/src/index.ts");
  const named = [];
  for (const match of server.matchAll(/(?:runStartupStep|recoverStep)\(\s*"[^"]+",\s*"([^"]+)"/g)) {
    if (!named.includes(match[1])) named.push(match[1]);
  }
  assert.ok(named.length >= 15);
  assert.deepEqual([...startupSteps()].sort(), [...named].sort());
  assert.equal(stepInSentence("Checking assigned tasks"), "checking assigned tasks");
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

    const steps = source.steps ?? {};
    assert.deepEqual(Object.keys(steps).sort(), [...startupSteps()].sort(), "startup steps");
    for (const [label, text] of Object.entries(steps)) {
      assert.equal(typeof text, "string", label);
      assert.equal(text, text.trim(), label);
      assert.notEqual(text, stepInSentence(label), label);
      if (SCRIPT[language]) assert.match(text, SCRIPT[language], `${label} → ${text}`);
      assert.equal(connect[stepInSentence(label)], text, label);
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
