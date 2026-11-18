#!/usr/bin/env node
/**
 * The Automa app's own screens in every language, from one file per language
 * (mobile/android/i18n/<code>.json: "connect" for the connect screen, "android"
 * for the app's string resources, "steps" for the server's startup steps). Writes
 *   - app/src/main/assets/connect/i18n/<code>.json: the connect screen's words
 *     (ones the board also shows come from ui/src/i18n/builtin/<code>.json),
 *   - app/src/main/res/values-<qualifier>/strings.xml, and
 *   - app/src/main/res/values[-<qualifier>]/startup_steps.xml: the startup steps.
 * `--check` fails when a written file is out of date (CI).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ANDROID_ROOT = path.resolve(here, "..");
const REPO_ROOT = path.resolve(ANDROID_ROOT, "../..");
const SOURCES = path.join(ANDROID_ROOT, "i18n");
const BOARD_BUILTIN = path.join(REPO_ROOT, "ui/src/i18n/builtin");
const CONNECT_OUT = path.join(ANDROID_ROOT, "app/src/main/assets/connect/i18n");
const RES = path.join(ANDROID_ROOT, "app/src/main/res");

/** Android resource folders for each language; Hebrew and Indonesian keep the codes Android has always matched. */
export const ANDROID_QUALIFIERS = {
  ar: ["ar"], bn: ["bn"], cs: ["cs"], da: ["da"], de: ["de"], el: ["el"], es: ["es"], fa: ["fa"], fi: ["fi"],
  fil: ["fil"], fr: ["fr"], he: ["iw"], hi: ["hi"], hu: ["hu"], id: ["in"], it: ["it"], ja: ["ja"], ko: ["ko"],
  mr: ["mr"], ms: ["ms"], nb: ["nb"], nl: ["nl"], pa: ["pa"], pl: ["pl"],
  // Portuguese from anywhere else reads the Brazilian wording, as on the board.
  "pt-BR": ["pt", "pt-rBR"], "pt-PT": ["pt-rPT"],
  ro: ["ro"], ru: ["ru"], sv: ["sv"], sw: ["sw"], ta: ["ta"], te: ["te"], th: ["th"], tr: ["tr"], uk: ["uk"],
  ur: ["ur"], vi: ["vi"], "zh-CN": ["zh-rCN"], "zh-TW": ["zh-rTW"],
};

export const LANGUAGES = Object.keys(ANDROID_QUALIFIERS);

/** Languages written right to left. */
export const RTL_LANGUAGES = ["ar", "fa", "he", "ur"];
const RLM = "‏";
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const LTR_LETTER = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u;

/**
 * Android lays a line out in the direction of its first letter, so a right-to-left
 * sentence that starts with "Automa", "Termux" or a %1$s (a file name, a host) would
 * be laid out left to right and read in the wrong order. Such lines start with an
 * invisible right-to-left mark instead. Lines with no right-to-left letters stay as written.
 */
export function rtlParagraph(text) {
  if (!RTL_LETTER.test(text)) return text;
  for (let i = 0; i < text.length; i += 1) {
    const placeholder = /^%\d+\$([0-9]*)([sd])/.exec(text.slice(i));
    if (placeholder) {
      if (placeholder[2] === "s") return `${RLM}${text}`;
      i += placeholder[0].length - 1;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i));
    if (RTL_LETTER.test(char)) return text;
    if (LTR_LETTER.test(char)) return `${RLM}${text}`;
  }
  return text;
}

export function connectStrings() {
  return JSON.parse(readFileSync(path.join(SOURCES, "connect-strings.json"), "utf8"));
}

/**
 * The steps a starting Automa names, as the server writes them (server/src/index.ts,
 * in English). The app and the connect screen show one after "Now:" or "Automa is
 * starting up:", first letter lowered ("checking assigned tasks"); each language
 * translates that form.
 */
export function startupSteps() {
  return JSON.parse(readFileSync(path.join(SOURCES, "startup-steps.json"), "utf8"));
}

/** A step as it reads inside a sentence, the way connect.js and the app lower it. */
export function stepInSentence(label) {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function unescapeAndroid(text) {
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\\n/g, "\n").replace(/\\(['"@?\\])/g, "$1");
}

/** The English app strings (res/values/strings.xml), translatable ones only, in file order. */
export function androidStrings() {
  const xml = readFileSync(path.join(RES, "values/strings.xml"), "utf8");
  const out = {};
  for (const match of xml.matchAll(/<string\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/string>/g)) {
    if (/translatable="false"/.test(match[2])) continue;
    out[match[1]] = unescapeAndroid(match[3]);
  }
  return out;
}

/** A value as an Android string resource writes it. */
export function escapeAndroid(text) {
  let out = text
    .replace(/\\/g, "\\\\").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/\n/g, "\\n");
  if (/^[@?]/.test(out)) out = `\\${out}`;
  return out;
}

export function readSource(language) {
  return JSON.parse(readFileSync(path.join(SOURCES, `${language}.json`), "utf8"));
}

function readBoard(language) {
  const file = path.join(BOARD_BUILTIN, `${language}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

/** The connect screen's dictionary for a language: its own translations, else the board's. */
export function connectDictionary(language) {
  const source = readSource(language);
  const own = source.connect ?? {};
  const board = readBoard(language);
  const out = {};
  for (const english of connectStrings()) {
    const text = own[english] ?? board[english];
    if (typeof text === "string" && text) out[english] = text;
  }
  // Startup steps, as they read inside "Automa is starting up: {0}…".
  const steps = source.steps ?? {};
  for (const label of startupSteps()) {
    if (typeof steps[label] === "string" && steps[label]) out[stepInSentence(label)] = steps[label];
  }
  return out;
}

export function renderConnect(language) {
  return `${JSON.stringify(connectDictionary(language), null, 2)}\n`;
}

export function renderAndroid(language) {
  const english = androidStrings();
  const own = readSource(language).android ?? {};
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', `<!-- Made by mobile/android/scripts/sync-translations.mjs from mobile/android/i18n/${language}.json. -->`, "<resources>"];
  const rtl = RTL_LANGUAGES.includes(language);
  for (const name of Object.keys(english)) {
    if (typeof own[name] !== "string" || !own[name]) continue;
    const text = rtl ? rtlParagraph(own[name]) : own[name];
    lines.push(`    <string name="${name}">${escapeAndroid(text)}</string>`);
  }
  lines.push("</resources>", "");
  return lines.join("\n");
}

function xmlItems(texts) {
  return texts.map((text) => `        <item>${escapeAndroid(text)}</item>`);
}

/**
 * The startup steps for the app's "Now: …" line: the server's English names
 * (looked up, never shown) and, in each language, the name as it reads there.
 * A language missing a step is not written (the app then shows the English).
 */
export function renderSteps(language) {
  const labels = startupSteps();
  const head = ['<?xml version="1.0" encoding="utf-8"?>', `<!-- Made by mobile/android/scripts/sync-translations.mjs from mobile/android/i18n/${language ?? "startup-steps"}.json. -->`, "<resources>"];
  if (!language) {
    return [
      ...head,
      '    <string-array name="startup_step_labels" translatable="false">', ...xmlItems(labels), "    </string-array>",
      '    <string-array name="startup_step_names">', ...xmlItems(labels.map(stepInSentence)), "    </string-array>",
      "</resources>", "",
    ].join("\n");
  }
  const steps = readSource(language).steps ?? {};
  const names = labels.map((label) => steps[label]);
  if (names.some((name) => typeof name !== "string" || !name)) return null;
  return [...head, '    <string-array name="startup_step_names">', ...xmlItems(names), "    </string-array>", "</resources>", ""].join("\n");
}

/** Every file this script writes, with its content. */
export function outputs() {
  const files = [{ file: path.join(RES, "values", "startup_steps.xml"), content: renderSteps(null) }];
  for (const language of LANGUAGES) {
    files.push({ file: path.join(CONNECT_OUT, `${language}.json`), content: renderConnect(language) });
    const android = renderAndroid(language);
    const steps = renderSteps(language);
    for (const qualifier of ANDROID_QUALIFIERS[language]) {
      files.push({ file: path.join(RES, `values-${qualifier}`, "strings.xml"), content: android });
      if (steps) files.push({ file: path.join(RES, `values-${qualifier}`, "startup_steps.xml"), content: steps });
    }
  }
  return files;
}

/** Written files no language owns any more (a removed language, or steps a language no longer has). */
export function strays() {
  const wanted = new Set(outputs().map(({ file }) => file));
  const found = [];
  if (existsSync(CONNECT_OUT)) {
    for (const name of readdirSync(CONNECT_OUT)) {
      const file = path.join(CONNECT_OUT, name);
      if (!wanted.has(file)) found.push(file);
    }
  }
  for (const folder of readdirSync(RES)) {
    const file = path.join(RES, folder, "startup_steps.xml");
    if (/^values(-|$)/.test(folder) && existsSync(file) && !wanted.has(file)) found.push(file);
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const { file, content } of outputs()) {
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current === content) continue;
    if (check) stale.push(path.relative(REPO_ROOT, file));
    else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  const extra = strays().map((file) => path.relative(REPO_ROOT, file));
  if (check && (stale.length || extra.length)) {
    console.error(`App translations are out of date: run pnpm i18n:android\n${[...stale, ...extra].join("\n")}`);
    process.exit(1);
  }
  if (!check && extra.length) console.warn(`Not made by any language (remove them): ${extra.join(", ")}`);
  console.log(check ? `App translations up to date (${LANGUAGES.length} languages)` : `Wrote app translations for ${LANGUAGES.length} languages`);
}
