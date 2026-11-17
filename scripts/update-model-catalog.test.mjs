import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { main, renderSnapshot } from "./update-model-catalog.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_API = path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "esm", "api", "index.mjs");
// The script reads the catalog with the shared parser through tsx; a checkout
// without dependencies installed reports these tests as skipped.
const skip = existsSync(TSX_API) ? false : "needs pnpm install (tsx)";

function catalogAnswer(count) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      id: i === 0 ? "google/gemini-4-hydrogen" : `maker/model-${i}`,
      name: i === 0 ? "Google: Gemini 4 Hydrogen" : `Model ${i}`,
      created: 1_794_000_000 - i * 3600,
      context_length: 1_000_000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
      pricing: { prompt: "0.000001", completion: "0.000004" },
    })),
  };
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "model-catalog-script-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("writes the built-in catalog from a catalog answer, newest first", { skip }, async (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, "catalog.json");
  const out = path.join(dir, "snapshot.ts");
  writeFileSync(from, JSON.stringify(catalogAnswer(60)));
  const lines = [];
  const count = await main(["--from", from, "--out", out, "--fetched-at", "2026-11-17T00:00:00.000Z"], { log: (line) => lines.push(line) });
  assert.equal(count, 60);
  assert.match(lines.join("\n"), /60 models .*newest google\/gemini-4-hydrogen/);
  const source = readFileSync(out, "utf8");
  assert.match(source, /export const MODEL_CATALOG_SNAPSHOT_FETCHED_AT = "2026-11-17T00:00:00.000Z";/);
  // The written module is real TypeScript the server can import.
  const { tsImport } = await import(pathToFileURL(TSX_API).href);
  const snapshot = await tsImport(pathToFileURL(out).href, import.meta.url);
  assert.equal(snapshot.MODEL_CATALOG_SNAPSHOT.length, 60);
  assert.deepEqual(snapshot.MODEL_CATALOG_SNAPSHOT[0], {
    id: "google/gemini-4-hydrogen",
    name: "Google: Gemini 4 Hydrogen",
    created: 1_794_000_000,
    context: 1_000_000,
    tools: true,
    input: ["text"],
    output: ["text"],
    price: { input: 0.000001, output: 0.000004 },
  });
});

test("keeps the built-in catalog as it was when the answer is too small to be a catalog", { skip }, async (t) => {
  const dir = tempDir(t);
  const from = path.join(dir, "catalog.json");
  const out = path.join(dir, "snapshot.ts");
  writeFileSync(from, JSON.stringify(catalogAnswer(3)));
  writeFileSync(out, "// the snapshot as it was\n");
  await assert.rejects(main(["--from", from, "--out", out], { log: () => {} }), /listed only 3 models/);
  assert.equal(readFileSync(out, "utf8"), "// the snapshot as it was\n");
});

test("renders one model per line under a header that says how to refresh it", () => {
  const text = renderSnapshot([{ id: "a/b", name: "B", created: 1, context: null, tools: false, input: [], output: ["text"], price: null }], "2026-11-17T00:00:00.000Z");
  assert.match(text, /pnpm models:update/);
  assert.match(text, /^ {2}\{"id":"a\/b",.*\},$/m);
});
