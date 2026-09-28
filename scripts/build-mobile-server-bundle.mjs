#!/usr/bin/env node
// Packs this checkout's Automa server into the Android app, so "Run Automa on
// this phone" installs the same server version as the app (not the upstream
// npm release) without building the monorepo on the phone.
//
// It mirrors `paperclipai install --ref` (cli/src/commands/install.ts): build
// the CLI bundle and the server's workspace packages, `pnpm pack` each one,
// then ship the tarballs with mobile/termux/install.sh. On the phone, Termux
// runs `npm install` on those tarballs, which fetches only ordinary npm
// dependencies for the phone's own platform.
//
// Output: mobile/android/app/src/main/assets/server/automa-server.tar.xz
// (the packages unpacked and slimmed; xz keeps the APK small, and install.sh
// packs each one back into a tarball for npm on the phone)
// Usage:  pnpm mobile:bundle-server   (pass --reuse-ui to skip the UI build)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = path.join(repoRoot, "cli");
const assetsDir = path.join(repoRoot, "mobile", "android", "app", "src", "main", "assets", "server");
const reuseUi = process.argv.includes("--reuse-ui");

function run(file, args, options = {}) {
  console.log(`  $ ${[file, ...args].join(" ")}`);
  execFileSync(file, args, { cwd: repoRoot, stdio: "inherit", ...options, env: { ...process.env, ...options.env } });
}

/** Workspace packages the server needs, dependencies first (same walk as the CLI's git install). */
function serverWorkspacePackages() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "scripts", "release-package-manifest.json"), "utf8"));
  const byName = new Map(manifest.map((entry) => [entry.name, entry]));
  const ordered = [];
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    visited.add(name);
    const entry = byName.get(name);
    if (!entry) throw new Error(`${name} is missing from scripts/release-package-manifest.json`);
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, entry.dir, "package.json"), "utf8"));
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(pkg[section] ?? {})) {
        if (dependency.startsWith("@paperclipai/")) visit(dependency);
      }
    }
    ordered.push(entry);
  };
  visit("@paperclipai/server");
  return ordered;
}

/**
 * Unpacks one package into packages/<name>/package and drops what never runs
 * on the phone: source maps, TypeScript declarations, compiled tests, and
 * native programs built for this machine instead of the phone (esbuild's
 * binary, the runner daemon).
 *
 * Also pins each @paperclipai/* dependency to the version actually packed:
 * bundled-package staging writes the depending package's own version, which
 * only matches when every package shares one release version (the plugin SDK
 * does not).
 */
function slimPackage(tarball, packedVersions, packagesDir) {
  const workDir = path.join(packagesDir, path.basename(tarball, ".tgz"));
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", workDir]);
  const removable = (relative, name) =>
    name.endsWith(".map") ||
    /\.d\.(c|m)?ts$/.test(name) ||
    /\.test\.(c|m)?js$/.test(name) ||
    /(^|\/)dist\/(.*\/)?__tests__$/.test(relative) ||
    /(^|\/)node_modules\/@esbuild$/.test(relative) ||
    // The native runner daemon is a Linux x86-64 program; it cannot run on a phone.
    /(^|\/)dist\/vendor\/paperclip-runner\/bin$/.test(relative);
  let removedBytes = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const relative = path.relative(workDir, full).split(path.sep).join("/");
      const stats = statSync(full, { throwIfNoEntry: false });
      if (!stats) continue;
      if (removable(relative, name)) {
        removedBytes += stats.isDirectory() ? Number(execFileSync("du", ["-sb", full], { encoding: "utf8" }).split("\t")[0]) : stats.size;
        rmSync(full, { recursive: true, force: true });
      } else if (stats.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(workDir);
  const manifestPath = path.join(workDir, "package", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (packedVersions.has(name)) manifest[section][name] = packedVersions.get(name);
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(tarball);
  console.log(`  ${path.basename(tarball)}: removed ${(removedBytes / 1024 / 1024).toFixed(1)} MB`);
}

const staging = path.join(os.tmpdir(), `automa-server-bundle-${process.pid}`);
const bundleDir = path.join(staging, "automa-server");
rmSync(staging, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });

const SKILL_PACKAGE_DIRS = ["server", "packages/adapters/claude-local", "packages/adapters/codex-local"];
const cliPackageJson = path.join(cliDir, "package.json");
const cliPackageBackup = path.join(cliDir, "package.dev.json");
const cliReadme = path.join(cliDir, "README.md");
const cliReadmeText = readFileSync(cliReadme, "utf8");
try {
  console.log("==> Building the board UI");
  if (!reuseUi || !existsSync(path.join(repoRoot, "ui", "dist", "index.html"))) {
    run("pnpm", ["--filter", "@paperclipai/ui", "build"]);
  }

  console.log("==> Bundling the CLI");
  run("bash", ["scripts/build-npm.sh", "--skip-checks", "--skip-typecheck"]);

  console.log("==> Building the server and its workspace packages");
  run("pnpm", ["-r", "--filter", "@paperclipai/server...", "--if-present", "run", "build"]);

  // Like scripts/release.sh: the server serves the board UI from ui-dist, and
  // the server and local adapters ship the Paperclip skills.
  run("bash", ["scripts/prepare-server-ui-dist.sh"], { env: { PAPERCLIP_RELEASE_REUSE_UI_DIST: "1" } });
  for (const dir of SKILL_PACKAGE_DIRS) {
    rmSync(path.join(repoRoot, dir, "skills"), { recursive: true, force: true });
    cpSync(path.join(repoRoot, "skills"), path.join(repoRoot, dir, "skills"), { recursive: true });
  }

  console.log("==> Packing");
  const packages = serverWorkspacePackages();
  for (const [index, entry] of packages.entries()) {
    const dir = path.join(repoRoot, entry.dir);
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies ?? [];
    if (bundled.length > 0) {
      const prepared = path.join(staging, `workspace-package-${index}`);
      run(process.execPath, [path.join(repoRoot, "scripts", "prepare-bundled-package.mjs"), dir, prepared]);
      // Already built above; the staged copy has no repo scripts for prepack to call.
      run("npm", ["pack", prepared, "--ignore-scripts", "--pack-destination", bundleDir]);
    } else {
      run("pnpm", ["--dir", entry.dir, "pack", "--pack-destination", bundleDir], { env: { PAPERCLIP_RELEASE_REUSE_UI_DIST: "1" } });
    }
  }
  run("npm", ["pack", "--pack-destination", bundleDir], { cwd: cliDir });

  console.log("==> Slimming for the phone");
  const packedVersions = new Map();
  for (const tarball of readdirSync(bundleDir).filter((name) => name.endsWith(".tgz"))) {
    const manifest = JSON.parse(execFileSync("tar", ["-xzOf", path.join(bundleDir, tarball), "package/package.json"], { encoding: "utf8" }));
    packedVersions.set(manifest.name, manifest.version);
  }
  const packagesDir = path.join(bundleDir, "packages");
  for (const tarball of readdirSync(bundleDir).filter((name) => name.endsWith(".tgz"))) {
    slimPackage(path.join(bundleDir, tarball), packedVersions, packagesDir);
  }

  const version = JSON.parse(readFileSync(cliPackageJson, "utf8")).version;
  const packed = readdirSync(path.join(bundleDir, "packages"));
  if (packed.length !== packages.length + 1) {
    throw new Error(`Packed ${packed.length} packages; expected ${packages.length + 1}.`);
  }
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    // A source archive without git history still bundles.
  }
  writeFileSync(path.join(bundleDir, "VERSION"), `${version} (${commit})\n`);
  for (const file of ["install.sh", "add-sharp-wasm.mjs"]) {
    cpSync(path.join(repoRoot, "mobile", "termux", file), path.join(bundleDir, file));
  }

  rmSync(assetsDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });
  const output = path.join(assetsDir, "automa-server.tar.xz");
  run("tar", ["-cJf", output, "-C", staging, "automa-server"], { env: { XZ_OPT: "-9 -T0" } });
  const megabytes = (statSync(output).size / 1024 / 1024).toFixed(1);
  console.log(`==> ${path.relative(repoRoot, output)}: ${packed.length} packages, ${megabytes} MB, version ${version} (${commit})`);
} finally {
  // build-npm.sh swaps in a publishable package.json; put the workspace one back.
  // It also rewrites the CLI README for npm; restore the tracked one.
  if (existsSync(cliPackageBackup)) renameSync(cliPackageBackup, cliPackageJson);
  writeFileSync(cliReadme, cliReadmeText);
  rmSync(path.join(repoRoot, "server", "ui-dist"), { recursive: true, force: true });
  for (const dir of SKILL_PACKAGE_DIRS) rmSync(path.join(repoRoot, dir, "skills"), { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
}
