#!/usr/bin/env node
// Copies the production board UI (ui/dist) into the Android app's assets so
// the APK carries the UI itself. The app answers the UI's own files from the
// APK on the server's origin (see mobile/android/.../BundledUi.kt); API calls
// still go to the server.
//
// Usage: pnpm mobile:bundle-ui   (builds the UI, then runs this script)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "ui", "dist");
const target = path.join(repoRoot, "mobile", "android", "app", "src", "main", "assets", "ui");

if (!existsSync(path.join(source, "index.html"))) {
  console.error("ui/dist/index.html is missing. Build the UI first: pnpm --filter @paperclipai/ui build");
  process.exit(1);
}

// Source maps and the developer-worktree favicons are not shipped.
const skip = (relative) => relative.endsWith(".map") || path.basename(relative).startsWith("worktree-favicon");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const relative = path.relative(source, full).split(path.sep).join("/");
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if (!skip(relative)) {
      mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
      cpSync(full, path.join(target, relative));
      files.push(relative);
    }
  }
}
walk(source);
files.sort();

let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
} catch {
  commit = null;
}

writeFileSync(path.join(target, "ui-manifest.json"), `${JSON.stringify({ commit, files }, null, 2)}\n`);
const bytes = files.reduce((sum, file) => sum + statSync(path.join(target, file)).size, 0);
console.log(`Bundled ${files.length} UI files (${(bytes / 1048576).toFixed(1)} MB) into ${path.relative(repoRoot, target)}`);
