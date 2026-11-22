#!/usr/bin/env node
/**
 * Lists every piece of text the board's own code shows, in English, and
 * writes it to packages/shared/src/ui-strings.generated.ts. This list is what
 * may be translated: the board translates on screen only text that is on it,
 * and the server's translation endpoint refuses anything else, so a person's
 * own words (chats, tasks, names) are never sent for translation.
 *
 * Read with Vite's parser (Oxc, already a dependency of the board):
 * - text inside JSX elements, as one template per run of text and values
 *   ("Delete {0} files?"), and each text piece alone for when the run is cut;
 * - string literals in JSX attributes that hold words (title, placeholder,
 *   aria-label, label, description…) or read as a sentence;
 * - string and template literals in code that hold words: object properties
 *   such as label/title/message, errors thrown, toasts, and any literal that
 *   reads as a sentence.
 * Values filled in at run time become {0}, {1}… Strings with no letters,
 * class names, paths, URLs and code are left out.
 *
 *   node ui/scripts/extract-ui-strings.mjs           # write the list
 *   node ui/scripts/extract-ui-strings.mjs --check   # fail when it is out of date
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(uiRoot, "..");
const srcRoot = path.join(uiRoot, "src");
export const OUTPUT = path.join(repoRoot, "packages", "shared", "src", "ui-strings.generated.ts");

/** JSX attributes that hold words for people. */
const TEXT_ATTRIBUTES = new Set([
  "title", "placeholder", "alt", "aria-label", "aria-description", "aria-placeholder", "aria-roledescription",
  "aria-valuetext", "label", "description", "heading", "subtitle", "hint", "tooltip", "emptyMessage", "emptyText",
  "emptyTitle", "emptyDescription", "message", "text", "caption", "confirmLabel", "cancelLabel", "submitLabel",
  "actionLabel", "buttonLabel", "helperText", "helpText", "summary", "detail", "body", "note", "eyebrow",
  "loadingText", "ctaLabel", "confirmText", "cancelText", "question", "headline", "lead",
]);
/** JSX attributes that never hold words for people, whatever their value looks like. */
const NON_TEXT_ATTRIBUTES = new Set([
  "className", "class", "id", "key", "href", "src", "srcSet", "to", "type", "name", "role", "method", "target", "rel",
  "as", "variant", "size", "side", "align", "htmlFor", "autoComplete", "autoCapitalize", "inputMode", "pattern",
  "accept", "value", "defaultValue", "mode", "kind", "tone", "color", "status", "icon", "testId", "lang", "dir",
  "style", "d", "viewBox", "fill", "stroke", "xmlns", "path", "route", "queryKey", "sizes", "media", "form",
  "action", "encType", "crossOrigin", "referrerPolicy", "sandbox", "allow", "loading", "decoding", "fetchPriority",
  "download", "slot", "part", "language", "provider", "model", "adapterType", "companyId", "agentId", "issueId",
  "field", "column", "format", "locale", "timeZone", "currency", "unit", "orientation", "position", "placement",
]);
/** Object keys whose values are words for people. */
const TEXT_KEYS = new Set([
  "label", "title", "description", "message", "text", "placeholder", "heading", "subtitle", "hint", "tooltip",
  "body", "detail", "details", "summary", "caption", "emptyText", "emptyMessage", "help", "helpText", "blurb",
  "ariaLabel", "confirmLabel", "cancelLabel", "actionLabel", "buttonLabel", "cta", "ctaLabel", "note", "warning",
  "question", "answer", "tagline", "headline", "eyebrow", "lead", "subtitleText", "shortLabel", "longLabel",
  "successMessage", "errorMessage", "confirmText", "loadingLabel", "doneLabel", "explanation", "reason", "tip",
]);
/** Calls whose first argument is words for people. */
const TEXT_CALLS = new Set(["alert", "confirm", "prompt", "setError", "setMessage", "setNotice", "setStatusText", "toast"]);

const LETTER = /\p{L}/u;

/** HTML character references JSX decodes in its text and attribute strings ("&amp;" shows as "&"). */
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  middot: "·", bull: "•", hellip: "…", mdash: "—", ndash: "–", times: "×", divide: "÷",
  rarr: "→", larr: "←", uarr: "↑", darr: "↓", harr: "↔",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", sect: "§", para: "¶",
  euro: "€", pound: "£", yen: "¥", cent: "¢",
};

export function decodeJsxEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g, (whole, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : whole;
  });
}

function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

function hasWords(text) {
  return LETTER.test(text.replace(/\{\d+\}/g, ""));
}

/** Class names, paths, URLs, ids, code. */
function looksLikeCode(text) {
  // A semicolon ends a statement or a CSS rule when no space follows it; in a sentence one does.
  if (/:\/\/|^\/|^\.\.?\/|\$\{|=>|[<>]|;(?!\s)|^[#@]|\b(?:true|false|null|undefined)\b$/.test(text)) return true;
  if (/^[a-z0-9:_\-/[\]().!%#&]+(?:\s+[a-z0-9:_\-/[\]().!%#&]+)*$/.test(text) && /[-:/_[\]]/.test(text)) return true; // tailwind-ish
  if (/^[A-Za-z0-9_.-]+$/.test(text) && /[._]/.test(text) && !/\s/.test(text)) return true; // dotted ids, snake_case keys
  if (/\.(?:tsx?|jsx?|json|css|svg|png|jpe?g|webp|md|html)\b/i.test(text)) return true;
  // SVG path data ("M{0},{1} l-10,-5 l0,10 z").
  if (/^[MmLlHhVvCcSsQqTtAaZz][\d{-]/.test(text) && /,/.test(text) && /^[MmLlHhVvCcSsQqTtAaZz\d{}.,\s-]+$/.test(text)) return true;
  return false;
}

/** Reads like words for a person: starts with a capital (or a digit or quote) and has a space. */
function looksLikeSentence(text) {
  return hasWords(text) && /\s/.test(text) && /^[\p{Lu}\d"'“‘(¿¡{]/u.test(text) && !looksLikeCode(text);
}

function templateOf(node) {
  // A template literal: its text with {0}, {1}… for its values.
  let out = "";
  node.quasis.forEach((quasi, index) => {
    out += quasi.value.cooked ?? quasi.value.raw;
    if (index < node.expressions.length) out += `{${index}}`;
  });
  return out;
}

function stringOf(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") return templateOf(node);
  return null;
}

function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent, key);
    return;
  }
  if (typeof node.type !== "string") return;
  if (visit(node, parent, key) === false) return;
  for (const [childKey, value] of Object.entries(node)) {
    if (childKey === "type" || childKey === "start" || childKey === "end" || childKey === "range" || childKey === "loc") continue;
    if (value && typeof value === "object") walk(value, visit, node, childKey);
  }
}

function attributeName(node) {
  const name = node.name;
  if (!name) return "";
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXNamespacedName") return `${name.namespace.name}:${name.name.name}`;
  return "";
}

function calleeName(node) {
  const callee = node.callee;
  if (!callee) return "";
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property?.type === "Identifier") return callee.property.name;
  return "";
}

function propertyKeyName(node) {
  const key = node.key;
  if (!key) return "";
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return "";
}

/** Literal strings a JSX child expression can render: the branches of ?:, && and ||. */
function renderedStrings(expression, add) {
  if (!expression) return;
  switch (expression.type) {
    case "Literal":
    case "TemplateLiteral": {
      const text = stringOf(expression);
      if (text !== null) add(text);
      return;
    }
    case "ConditionalExpression":
      renderedStrings(expression.consequent, add);
      renderedStrings(expression.alternate, add);
      return;
    case "LogicalExpression":
      renderedStrings(expression.right, add);
      if (expression.operator !== "&&") renderedStrings(expression.left, add);
      return;
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      renderedStrings(expression.expression, add);
      return;
    default:
  }
}

export function extractFromSource(source, filename) {
  const found = new Set();
  const add = (raw, { sentenceOnly = false } = {}) => {
    if (typeof raw !== "string") return;
    const text = normalize(raw);
    if (!text || text.length > 2000 || !hasWords(text) || looksLikeCode(text)) return;
    if (/^\{\d+\}$/.test(text)) return;
    if (sentenceOnly && !looksLikeSentence(text)) return;
    found.add(text);
  };
  const ast = parseAst(source, { lang: filename.endsWith(".tsx") ? "tsx" : "ts" });
  walk(ast, (node, parent, key) => {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
      case "TSEnumDeclaration":
      case "TSModuleDeclaration":
      case "TSLiteralType":
        return false;
      case "CallExpression": {
        const callee = node.callee;
        // Logs and test ids are not shown; i18n keys are translated elsewhere.
        if (callee?.type === "MemberExpression" && callee.object?.type === "Identifier" && ["console", "logger", "log"].includes(callee.object.name)) return false;
        const name = calleeName(node);
        if (name === "t" || name === "useTranslation" || name === "require" || name === "import") return false;
        if (TEXT_CALLS.has(name)) add(stringOf(node.arguments?.[0]));
        return undefined;
      }
      case "NewExpression": {
        if (/Error$/.test(calleeName(node))) add(stringOf(node.arguments?.[0]));
        return undefined;
      }
      case "JSXAttribute": {
        const name = attributeName(node);
        if (name.startsWith("data-") || /^on[A-Z]/.test(name)) return false;
        const value = node.value;
        // A JSX attribute string decodes entities; a JS string inside braces does not.
        const direct = stringOf(value);
        const text = value?.type === "JSXExpressionContainer" ? stringOf(value.expression) : direct === null ? null : decodeJsxEntities(direct);
        if (text !== null) {
          if (TEXT_ATTRIBUTES.has(name)) add(text);
          else if (!NON_TEXT_ATTRIBUTES.has(name)) add(text, { sentenceOnly: true });
        }
        if (value?.type === "JSXExpressionContainer" && TEXT_ATTRIBUTES.has(name)) renderedStrings(value.expression, add);
        return undefined;
      }
      case "JSXElement":
      case "JSXFragment": {
        let parts = [];
        let pieces = [];
        const flush = () => {
          const template = parts.join("");
          if (hasWords(template)) {
            add(template);
            if (/\{\d+\}/.test(template)) for (const piece of pieces) add(piece);
          }
          parts = [];
          pieces = [];
        };
        for (const child of node.children ?? []) {
          if (child.type === "JSXText") {
            const text = decodeJsxEntities(child.value);
            parts.push(text);
            pieces.push(text);
          } else if (child.type === "JSXExpressionContainer") {
            const expression = child.expression;
            if (!expression || expression.type === "JSXEmptyExpression") continue;
            const literal = expression.type === "Literal" && typeof expression.value === "string" ? expression.value : null;
            if (literal !== null) {
              parts.push(literal);
              pieces.push(literal);
            } else {
              parts.push(`{${parts.filter((part) => /^\{\d+\}$/.test(part)).length}}`);
              renderedStrings(expression, add);
            }
          } else {
            flush();
          }
        }
        flush();
        return undefined;
      }
      case "Property": {
        const keyName = propertyKeyName(node);
        const text = stringOf(node.value);
        if (text !== null && TEXT_KEYS.has(keyName)) add(text);
        return undefined;
      }
      case "Literal":
      case "TemplateLiteral": {
        // JSX attributes and properties are read above; elsewhere, sentences only.
        if (parent?.type === "JSXAttribute" || parent?.type === "Property" || parent?.type === "JSXExpressionContainer") return undefined;
        if (parent?.type === "MemberExpression" && key === "property") return undefined;
        add(stringOf(node), { sentenceOnly: true });
        return undefined;
      }
      default:
        return undefined;
    }
  });
  return found;
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "test" || name === "tests" || name === "fixtures" || name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|stories)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Text the board shows that lives outside ui/src: the Terminals page lists each
 * tool's name and one-line description from the catalog it shares with the server.
 */
export const SHARED_TEXT_FILES = [path.join(repoRoot, "packages", "shared", "src", "terminals.ts")];

export function extractAll() {
  const all = new Set();
  const failures = [];
  for (const file of [...sourceFiles(srcRoot).sort(), ...SHARED_TEXT_FILES]) {
    try {
      for (const text of extractFromSource(readFileSync(file, "utf8"), file)) all.add(text);
    } catch (error) {
      failures.push(`${path.relative(repoRoot, file)}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    }
  }
  if (failures.length) throw new Error(`Could not read ${failures.length} files:\n${failures.join("\n")}`);
  return [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function render(strings) {
  return `// Generated by ui/scripts/extract-ui-strings.mjs from ui/src and the shared catalogs the board shows. Do not edit by hand:
// run \`pnpm i18n:extract\` after changing the board's text.

/**
 * Every piece of text the board's own code shows, in English: what the board
 * may translate on screen and what the server's translation endpoint accepts.
 * {0}, {1}… stand for values filled in at run time.
 */
export const UI_STRINGS: readonly string[] = [
${strings.map((text) => `  ${JSON.stringify(text)},`).join("\n")}
];
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const strings = extractAll();
  const content = render(strings);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUTPUT, "utf8");
    } catch {
      // Missing: out of date.
    }
    if (current !== content) {
      console.error(`${path.relative(repoRoot, OUTPUT)} is out of date: run pnpm i18n:extract`);
      process.exit(1);
    }
    console.log(`${path.relative(repoRoot, OUTPUT)}: up to date (${strings.length} strings)`);
  } else {
    writeFileSync(OUTPUT, content);
    console.log(`wrote ${path.relative(repoRoot, OUTPUT)}: ${strings.length} strings, ${(Buffer.byteLength(content) / 1024).toFixed(0)} KB`);
  }
}
