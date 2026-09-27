#!/usr/bin/env node
/**
 * Rebrand user-visible product copy from "Paperclip" to "Automa".
 *
 * Only text a person reads is rewritten: string literals, template-literal
 * text, regular-expression literals (so tests keep matching), and JSX text.
 * Code identifiers (`<Paperclip />` icons, `PaperclipLockup`), protocol names
 * (`X-Paperclip-Signature`, `PAPERCLIP_*` env vars), import specifiers, and the
 * name of the separately operated "Paperclip Cloud" service stay as they are,
 * so wire formats and integrations keep working.
 *
 * Usage: node scripts/codemod-rebrand-automa.mjs [--check] [dir ...]
 * Default dir: ui/src. `--check` reports files that still need rewriting.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** @babel/parser ships transitively; find it in the pnpm store when unhoisted. */
function loadBabelParser() {
  const require = createRequire(import.meta.url);
  try {
    return require("@babel/parser");
  } catch {
    const store = path.resolve("node_modules/.pnpm");
    const entry = fs.readdirSync(store).filter((name) => name.startsWith("@babel+parser@")).sort().pop();
    if (!entry) throw new Error("@babel/parser is not installed; run pnpm install");
    return require(path.join(store, entry, "node_modules/@babel/parser"));
  }
}
const babelParser = loadBabelParser();

const NEW_NAME = "Automa";
const args = process.argv.slice(2);
const check = args.includes("--check");
const roots = args.filter((arg) => !arg.startsWith("--"));
if (roots.length === 0) roots.push("ui/src");

// "Paperclip" as a whole word, not glued to an identifier or a hyphenated
// protocol token, and not the external "Paperclip Cloud" service.
const WORD = /(?<![A-Za-z0-9_$\-.<\/@])Paperclip(?![A-Za-z0-9_$\-])(?! Cloud)(?!\.(?:ing|dev|ai)\b)/g;

function rewriteText(text) {
  return text.replace(WORD, NEW_NAME);
}

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (/\.(tsx?|mts|jsx?|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield full;
  }
}

function collectRanges(ast) {
  const ranges = [];
  const importSources = new Set();
  const visit = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    if (
      (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") &&
      node.source
    ) {
      importSources.add(node.source.start);
    }
    if (node.type === "CallExpression" && node.callee?.type === "Import" && node.arguments?.[0]) {
      importSources.add(node.arguments[0].start);
    }
    switch (node.type) {
      case "StringLiteral":
        if (!importSources.has(node.start) && !(parent?.type === "TSLiteralType")) {
          ranges.push([node.start + 1, node.end - 1]);
        }
        break;
      case "TemplateElement":
        ranges.push([node.start, node.end]);
        break;
      case "JSXText":
        ranges.push([node.start, node.end]);
        break;
      case "RegExpLiteral":
        ranges.push([node.start + 1, node.start + 1 + node.pattern.length]);
        break;
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => visit(child, node));
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value, node);
    }
  };
  visit(ast.program, null);
  return ranges.sort((a, b) => a[0] - b[0]);
}

let changedFiles = 0;
let changedOccurrences = 0;
for (const root of roots) {
  for (const file of walkFiles(root)) {
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes("Paperclip")) continue;
    let ast;
    try {
      ast = babelParser.parse(source, {
        sourceType: "module",
        plugins: ["typescript", "jsx", "decorators-legacy", "importAttributes"],
        errorRecovery: true,
      });
    } catch (err) {
      console.warn(`skip (parse error): ${file}: ${err.message}`);
      continue;
    }
    let output = "";
    let cursor = 0;
    let count = 0;
    for (const [start, end] of collectRanges(ast)) {
      if (start < cursor) continue;
      const segment = source.slice(start, end);
      const rewritten = rewriteText(segment);
      if (rewritten !== segment) {
        count += (segment.match(WORD) ?? []).length;
        output += source.slice(cursor, start) + rewritten;
        cursor = end;
      }
    }
    if (count === 0) continue;
    output += source.slice(cursor);
    changedFiles += 1;
    changedOccurrences += count;
    if (check) console.log(`${file}: ${count}`);
    else fs.writeFileSync(file, output);
  }
}

console.log(`${check ? "Would rewrite" : "Rewrote"} ${changedOccurrences} occurrence(s) in ${changedFiles} file(s).`);
if (check && changedFiles > 0) process.exitCode = 1;
