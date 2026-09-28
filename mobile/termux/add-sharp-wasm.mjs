#!/usr/bin/env node
// sharp (image processing: agent avatars, photos) ships native builds for
// Linux, macOS and Windows, but not Android, so on a phone it cannot load.
// Its official fallback is the WebAssembly build, @img/sharp-wasm32, which
// runs anywhere Node runs. npm will not install it on an arm64 phone (the
// package declares cpu "wasm32"), so this places the build that matches each
// installed sharp, and its @emnapi/runtime dependency, beside that sharp.
//
// Usage (install.sh runs it): node add-sharp-wasm.mjs <server install dir>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const scratch = mkdtempSync(path.join(os.tmpdir(), "automa-sharp-"));

/** Every installed copy of sharp under node_modules. */
function findSharpCopies(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === "sharp" && path.basename(dir) === "node_modules" && existsSync(path.join(full, "package.json"))) {
      found.push(full);
    }
    // Walk node_modules folders, the packages and scopes inside them, and their own node_modules.
    const inPackageList = path.basename(dir) === "node_modules" || path.basename(dir).startsWith("@");
    if (entry.name === "node_modules" || inPackageList) {
      findSharpCopies(full, found);
    }
  }
  return found;
}

/** Downloads one npm package (any version range) and unpacks it into `target`. */
function unpack(spec, target) {
  const name = execFileSync("npm", ["pack", spec, "--silent", "--pack-destination", scratch], { cwd: scratch, encoding: "utf8" })
    .trim()
    .split("\n")
    .pop();
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(scratch, name), "-C", target, "--strip-components=1"]);
  return JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"));
}

try {
  const copies = findSharpCopies(path.join(root, "node_modules"));
  if (copies.length === 0) console.log("No sharp install found; nothing to add.");
  for (const sharpDir of copies) {
    const { version } = JSON.parse(readFileSync(path.join(sharpDir, "package.json"), "utf8"));
    const wasmDir = path.join(sharpDir, "node_modules", "@img", "sharp-wasm32");
    if (existsSync(path.join(wasmDir, "sharp.node")) || existsSync(path.join(wasmDir, "package.json"))) continue;
    const wasm = unpack(`@img/sharp-wasm32@${version}`, wasmDir);
    for (const [dependency, range] of Object.entries(wasm.dependencies ?? {})) {
      unpack(`${dependency}@${range}`, path.join(wasmDir, "node_modules", ...dependency.split("/")));
    }
    console.log(`Added the WebAssembly build of sharp ${version} (${path.relative(root, sharpDir)}).`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
