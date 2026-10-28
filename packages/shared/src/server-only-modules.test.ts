import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(fileURLToPath(import.meta.url));
// puter-ai holds the free-model service token; the Que modules call the service with it.
const SERVER_ONLY = ["puter-ai.ts", "que-engine.ts", "que-queue.ts"];

/** The files a module pulls in at runtime: value imports and re-exports, not `import type`. */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  const statements = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of source.matchAll(statements)) {
    if (!match[2]) found.push(match[3]!);
  }
  for (const match of source.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) found.push(match[1]!);
  return found
    .map((spec) => path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")))
    .map((resolved) => (existsSync(resolved) ? resolved : path.join(resolved.replace(/\.ts$/, ""), "index.ts")))
    .filter((resolved) => existsSync(resolved));
}

describe("server-only modules", () => {
  it("stay out of everything the package index (and so the web bundle) loads", () => {
    const seen = new Set<string>();
    const queue = [path.join(SRC, "index.ts")];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...runtimeImports(file));
    }
    const reached = [...seen].map((file) => path.relative(SRC, file));
    expect(reached.length).toBeGreaterThan(20);
    expect(reached.filter((file) => SERVER_ONLY.includes(file))).toEqual([]);
  });
});
