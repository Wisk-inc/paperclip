import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refuse = vi.hoisted(() => ({ code: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (from: string, to: string) => {
      if (refuse.code) throw Object.assign(new Error(`${refuse.code}: link refused`), { code: refuse.code });
      return actual.linkSync(from, to);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const link = async (from: string, to: string) => {
    if (refuse.code) throw Object.assign(new Error(`${refuse.code}: link refused`), { code: refuse.code });
    return actual.link(from, to);
  };
  return { ...actual, default: { ...actual, link }, link };
});

const { publishExclusive, publishExclusiveSync } = await import("./exclusive-publish.js");

describe("exclusive publish", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "exclusive-publish-"));
    refuse.code = null;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  for (const code of [null, "EACCES", "EPERM"]) {
    const label = code ? `when hard links are refused (${code}, as on Android)` : "with hard links";
    it(`publishes once and never replaces an existing file ${label}`, async () => {
      refuse.code = code;
      const temp = path.join(dir, "key.tmp");
      const target = path.join(dir, "key");
      writeFileSync(temp, "first");
      publishExclusiveSync(temp, target, "first", 0o600);
      expect(readFileSync(target, "utf8")).toBe("first");

      const second = path.join(dir, "key.second.tmp");
      writeFileSync(second, "second");
      expect(() => publishExclusiveSync(second, target, "second")).toThrow(expect.objectContaining({ code: "EEXIST" }));
      await expect(publishExclusive(second, target, "second")).rejects.toMatchObject({ code: "EEXIST" });
      expect(readFileSync(target, "utf8")).toBe("first");
    });
  }

  it("still fails on errors that are not a refused link", () => {
    refuse.code = "ENOSPC";
    const temp = path.join(dir, "key.tmp");
    writeFileSync(temp, "x");
    expect(() => publishExclusiveSync(temp, path.join(dir, "key"), "x")).toThrow(expect.objectContaining({ code: "ENOSPC" }));
  });
});
