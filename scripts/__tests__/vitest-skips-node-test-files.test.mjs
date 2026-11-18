// Test files written for Node's own runner (`import { test } from "node:test"`) must stay out of
// the Vitest projects listed in vitest.config.ts. Vitest finds no suite in such a file and fails
// the whole project's run with "No test suite found", which is what `pnpm test:run` and the PR
// workflow's general groups run. Each such file is run with `node --test` instead, so this also
// checks that the PR workflow still runs every one it keeps out of Vitest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const NODE_TEST_IMPORT = /(?:from\s*|require\(\s*|import\(\s*)["']node:test["']/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".turbo"]);

/** The project folders vitest.config.ts lists. */
function vitestProjects() {
  const config = readFileSync(path.join(repoRoot, "vitest.config.ts"), "utf8");
  const list = /projects:\s*\[([\s\S]*?)\]/.exec(config);
  assert.ok(list, "vitest.config.ts lists its projects");
  const projects = [...list[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(projects.length > 0, "vitest.config.ts lists at least one project");
  return projects;
}

/** Test files under a folder, as repository paths, without build output or dependencies. */
function testFilesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...testFilesUnder(relative));
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      found.push(relative);
    }
  }
  return found;
}

const usesNodeTest = (file) => NODE_TEST_IMPORT.test(readFileSync(path.join(repoRoot, file), "utf8"));

/** The files Vitest would run, out of `files`, as repository paths. */
function vitestWouldRun(files) {
  const scratch = mkdtempSync(path.join(tmpdir(), "vitest-list-"));
  const output = path.join(scratch, "list.json");
  try {
    execFileSync(
      process.execPath,
      [path.join(repoRoot, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", `--json=${output}`, ...files],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, CI: "1" } },
    );
    return JSON.parse(readFileSync(output, "utf8")).map((entry) => path.relative(repoRoot, entry.file).split(path.sep).join("/"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("no Vitest project collects a test file written for node --test", () => {
  const nodeTestFiles = [];
  const controls = [];
  for (const project of vitestProjects()) {
    const files = testFilesUnder(project);
    const own = files.filter(usesNodeTest);
    if (own.length === 0) continue;
    nodeTestFiles.push(...own);
    // An ordinary Vitest file of the same project: it must be listed, so an empty list proves nothing.
    const control = files.find((file) => !own.includes(file) && /\.test\.tsx?$/.test(file));
    assert.ok(control, `${project} has a Vitest test file to compare with`);
    controls.push(control);
  }
  if (nodeTestFiles.length === 0) return;

  const listed = vitestWouldRun([...nodeTestFiles, ...controls]);
  for (const control of controls) assert.ok(listed.includes(control), `Vitest lists ${control}`);
  assert.deepEqual(
    nodeTestFiles.filter((file) => listed.includes(file)),
    [],
    "these node --test files are collected by a Vitest project, which then fails with \"No test suite found\"",
  );
});

test("the PR workflow runs each node --test file kept out of the Vitest projects", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/pr-trusted.yml"), "utf8");
  const runs = [...workflow.matchAll(/node --test ([^\n]+)/g)].flatMap((match) => match[1].trim().split(/\s+/));
  const nodeTestFiles = vitestProjects().flatMap((project) => testFilesUnder(project).filter(usesNodeTest));
  for (const file of nodeTestFiles) {
    assert.ok(
      runs.some((target) => target.replace(/^\.\//, "").replace(/^['"]|['"]$/g, "") === file),
      `.github/workflows/pr-trusted.yml runs ${file} with node --test`,
    );
  }
});
