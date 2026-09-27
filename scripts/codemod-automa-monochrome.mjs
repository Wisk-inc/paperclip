#!/usr/bin/env node
/**
 * Automa is monochrome: black and white carry the interface and color is kept
 * for status meaning (amber working, green done/live, red blocked). This
 * codemod maps Tailwind palette classes in the blue/violet family onto the
 * neutral zinc scale, keeping shade, opacity, and variant prefixes intact:
 *
 *   text-violet-600  -> text-zinc-600
 *   dark:bg-blue-900/50 -> dark:bg-zinc-900/50
 *
 * Usage: node scripts/codemod-automa-monochrome.mjs [--check] [dir ...]
 * Default dir: ui/src.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const check = args.includes("--check");
const roots = args.filter((arg) => !arg.startsWith("--"));
if (roots.length === 0) roots.push("ui/src");

const HUES = "violet|purple|indigo|blue|sky";
const UTILITIES = "text|bg|border|border-[trblxy]|ring|ring-offset|from|to|via|fill|stroke|outline|decoration|shadow|divide|accent|caret|placeholder";
const PATTERN = new RegExp(`(?<![A-Za-z0-9_-])((?:${UTILITIES})-)(?:${HUES})-(50|[1-9]00|950)(?![A-Za-z0-9_])`, "g");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(tsx?|jsx?|mjs|css)$/.test(entry.name)) yield full;
  }
}

let files = 0;
let hits = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    const source = fs.readFileSync(file, "utf8");
    let count = 0;
    const next = source.replace(PATTERN, (_match, utility, shade) => {
      count += 1;
      return `${utility}zinc-${shade}`;
    });
    if (count === 0) continue;
    files += 1;
    hits += count;
    if (check) console.log(`${file}: ${count}`);
    else fs.writeFileSync(file, next);
  }
}
console.log(`${check ? "Would rewrite" : "Rewrote"} ${hits} class(es) in ${files} file(s).`);
if (check && files > 0) process.exitCode = 1;
