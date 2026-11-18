import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeEntryWithoutFollowing } from "./remove-entry.js";

const gone = (path: string) => {
  expect(() => lstatSync(path)).toThrow(expect.objectContaining({ code: "ENOENT" }));
};

describe("removeEntryWithoutFollowing", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paperclip-remove-entry-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes a link to a directory and keeps the directory it points at", () => {
    const target = join(root, "outside");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep");
    const link = join(root, "tmp");
    symlinkSync(target, link, "dir");

    removeEntryWithoutFollowing(link, lstatSync(link));

    gone(link);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
  });

  it("removes a link to a file and keeps the file", () => {
    const target = join(root, "auth-outside.json");
    writeFileSync(target, "{}");
    const link = join(root, "auth.json");
    symlinkSync(target, link);

    removeEntryWithoutFollowing(link, lstatSync(link));

    gone(link);
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  it("removes a real directory with what it holds, and a file", () => {
    const directory = join(root, ".tmp");
    mkdirSync(join(directory, "nested"), { recursive: true });
    writeFileSync(join(directory, "nested", "scratch"), "x");
    const file = join(root, "config.toml");
    writeFileSync(file, "x = 1");

    removeEntryWithoutFollowing(directory, lstatSync(directory));
    removeEntryWithoutFollowing(file, lstatSync(file));

    expect(existsSync(directory)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("is quiet when the link is already gone", () => {
    const target = join(root, "outside");
    mkdirSync(target);
    const link = join(root, "tmp");
    symlinkSync(target, link, "dir");
    const stats = lstatSync(link);
    unlinkSync(link);

    expect(() => removeEntryWithoutFollowing(link, stats)).not.toThrow();
  });
});
