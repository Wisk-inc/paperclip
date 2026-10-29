import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStudioEntry, saveUploadedFile, saveUploadedTempFile, writeStudioFile } from "../services/studio/files.js";

let root = "";
let outside = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "studio-links-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "studio-links-outside-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const present = (target: string) => stat(target).then(() => true, () => false);

describe("Studio file writes and links", () => {
  it("refuses to write through a link to a missing file, and creates nothing outside", async () => {
    await symlink(path.join(outside, "authorized_keys"), path.join(root, "notes.txt"));
    await expect(writeStudioFile(root, "notes.txt", "written")).rejects.toThrow(/broken link/);
    expect(await present(path.join(outside, "authorized_keys"))).toBe(false);

    await symlink("../../somewhere/else.txt", path.join(root, "relative.txt"));
    await expect(writeStudioFile(root, "relative.txt", "written")).rejects.toThrow(/broken link/);
  });

  it("refuses uploads through a link to a missing file", async () => {
    await symlink(path.join(outside, "upload.bin"), path.join(root, "upload.bin"));
    await expect(saveUploadedFile(root, null, "upload.bin", Buffer.from("data"))).rejects.toThrow(/broken link/);
    expect(await present(path.join(outside, "upload.bin"))).toBe(false);

    const temp = path.join(outside, "multer-temp");
    await writeFile(temp, "data");
    await expect(saveUploadedTempFile(root, null, "upload.bin", temp)).rejects.toThrow(/broken link/);
  });

  it("refuses a path through a link to a missing folder", async () => {
    await symlink(path.join(outside, "missing-dir"), path.join(root, "dir"));
    await expect(writeStudioFile(root, "dir/a.txt", "written")).rejects.toThrow(/broken link/);
    expect(await present(path.join(outside, "missing-dir"))).toBe(false);
  });

  it("refuses links that loop", async () => {
    await symlink(path.join(root, "b"), path.join(root, "a"));
    await symlink(path.join(root, "a"), path.join(root, "b"));
    await expect(writeStudioFile(root, "a", "written")).rejects.toThrow(/broken link/);
  });

  it("still refuses, before writing, a link to an existing file outside the project", async () => {
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "secret.txt"));
    await expect(writeStudioFile(root, "secret.txt", "overwritten")).rejects.toThrow(/points outside the project/);
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("keeps normal writes, new folders and links inside the project working", async () => {
    await writeStudioFile(root, "src/new/deep.txt", "deep");
    expect(await readFile(path.join(root, "src/new/deep.txt"), "utf8")).toBe("deep");
    await createStudioEntry(root, "assets/images", "folder");
    expect((await stat(path.join(root, "assets/images"))).isDirectory()).toBe(true);

    await writeFile(path.join(root, "real.txt"), "old");
    await symlink("real.txt", path.join(root, "alias.txt"));
    const written = await writeStudioFile(root, "alias.txt", "new");
    expect(written.content).toBe("new");
    expect(await readFile(path.join(root, "real.txt"), "utf8")).toBe("new");

    await mkdir(path.join(root, "lib"));
    await symlink(path.join(root, "lib"), path.join(root, "lib-link"));
    await writeStudioFile(root, "lib-link/index.js", "export {};");
    expect(await readFile(path.join(root, "lib/index.js"), "utf8")).toBe("export {};");
  });
});
