import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Runs a copy of the bundle script in a throwaway checkout whose
// scripts/build-npm.sh is a stub: it swaps cli/package.json and the README the
// way the real one does, then fails or is interrupted. Nothing is built.
const script = new URL("../build-mobile-server-bundle.mjs", import.meta.url).pathname;

const WORKSPACE_MANIFEST = `${JSON.stringify({ name: "paperclipai", version: "0.3.1", scripts: { build: "tsc" } }, null, 2)}\n`;
const PUBLISH_MANIFEST = `${JSON.stringify({ name: "paperclipai", version: "0.3.1", files: ["dist"] }, null, 2)}\n`;
const README = "# The tracked CLI readme\n";

const SWAP = `set -e
cd "$(dirname "$0")/.."
cp cli/package.json cli/package.dev.json
cat > cli/package.json <<'EOF'
${PUBLISH_MANIFEST.trimEnd()}
EOF
printf 'npm readme\\n' > cli/README.md
`;

const cleanupDirs = [];
test.after(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCheckout(buildNpm) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "automa-bundle-test-")));
  cleanupDirs.push(root);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(script, path.join(root, "scripts", "build-mobile-server-bundle.mjs"));
  fs.writeFileSync(path.join(root, "scripts", "build-npm.sh"), buildNpm);
  fs.mkdirSync(path.join(root, "cli"));
  fs.writeFileSync(path.join(root, "cli", "package.json"), WORKSPACE_MANIFEST);
  fs.writeFileSync(path.join(root, "cli", "README.md"), README);
  // --reuse-ui skips the UI build when a built UI is there.
  fs.mkdirSync(path.join(root, "ui", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "ui", "dist", "index.html"), "<!doctype html>\n");
  fs.mkdirSync(path.join(root, "tmp"));
  return root;
}

function bundle(root) {
  return spawnSync(process.execPath, [path.join(root, "scripts", "build-mobile-server-bundle.mjs"), "--reuse-ui"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: path.join(root, "tmp") },
    timeout: 30_000,
  });
}

function assertWorkspaceRestored(root) {
  assert.equal(fs.readFileSync(path.join(root, "cli", "package.json"), "utf8"), WORKSPACE_MANIFEST);
  assert.equal(fs.existsSync(path.join(root, "cli", "package.dev.json")), false);
  assert.equal(fs.readFileSync(path.join(root, "cli", "README.md"), "utf8"), README);
  assert.deepEqual(fs.readdirSync(path.join(root, "tmp")), []);
}

test("puts the workspace package.json back when a step fails", () => {
  const root = makeCheckout(`${SWAP}exit 1\n`);
  const result = bundle(root);
  assert.notEqual(result.status, 0);
  assertWorkspaceRestored(root);
});

test("keeps the workspace package.json that an interrupted run left in the backup", () => {
  const root = makeCheckout(`${SWAP}exit 1\n`);
  // What a run killed after build-npm.sh leaves behind.
  fs.writeFileSync(path.join(root, "cli", "package.dev.json"), WORKSPACE_MANIFEST);
  fs.writeFileSync(path.join(root, "cli", "package.json"), PUBLISH_MANIFEST);
  const result = bundle(root);
  assert.notEqual(result.status, 0);
  assertWorkspaceRestored(root);
});

test("cleans up when Ctrl+C interrupts a step", () => {
  // The terminal sends SIGINT to the script and to the step it is running.
  const root = makeCheckout(`${SWAP}kill -INT "$PPID"\nsleep 1\nexit 130\n`);
  const result = bundle(root);
  assert.notEqual(result.status, 0);
  assertWorkspaceRestored(root);
});
