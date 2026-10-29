import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UI_SRC = fileURLToPath(new URL("..", import.meta.url));

/** Places Automa must not send people (or what they read) to. */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /docs\.paperclip\.ing/, why: "links to the upstream project's docs" },
  { pattern: /paperclip\.ing\/tos/, why: "links to the upstream project's terms" },
  { pattern: /github\.com\/paperclipai\/paperclip\/blob/, why: "links to the upstream project's repository" },
  { pattern: /icons\.duckduckgo\.com/, why: "tells a third party which sites people read" },
  { pattern: /Automa Labs/, why: "names a company that does not exist (Automa is made by Corx Labs)" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|stories)\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

describe("upstream links", () => {
  it("sends nobody to the upstream project or a third-party icon service", () => {
    const offenders = sourceFiles(UI_SRC).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return FORBIDDEN
        .filter(({ pattern }) => pattern.test(text))
        .map(({ why }) => `${path.relative(UI_SRC, file)}: ${why}`);
    });

    expect(offenders).toEqual([]);
  });
});
