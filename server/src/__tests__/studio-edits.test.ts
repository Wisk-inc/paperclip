import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { currentText, listEdits, recordEdit, undoEdit } from "../services/studio/edits.js";
import { deleteStudioEntry, writeStudioFile } from "../services/studio/files.js";

const company = "company-1";
let root = "";
let count = 0;
let workspace = "";
let files = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "studio-edits-"));
  process.env.PAPERCLIP_STUDIO_DIR = root;
});

afterAll(async () => {
  delete process.env.PAPERCLIP_STUDIO_DIR;
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  workspace = `ws-${++count}`;
  files = path.join(root, company, workspace, "files");
  await mkdir(files, { recursive: true });
});

/** Writes a file the way the assistant's write_file does, recording the change. */
async function write(relative: string, text: string, by = "assistant") {
  const before = await currentText(company, workspace, relative);
  await writeStudioFile(files, relative, text);
  return recordEdit(company, workspace, { path: relative, before, after: { exists: true, text }, by });
}

/** Deletes a file the way the assistant's delete_path does, recording the change. */
async function remove(relative: string) {
  const before = await currentText(company, workspace, relative);
  await deleteStudioEntry(files, relative);
  return recordEdit(company, workspace, { path: relative, before, after: { exists: false, text: null }, by: "assistant" });
}

const read = (relative: string) => readFile(path.join(files, relative), "utf8");
const present = (target: string) => stat(target).then(() => true, () => false);

describe("Studio edit log", () => {
  it("undoes a create by deleting the file, an edit by putting the text back, and a delete by restoring the file", async () => {
    const created = await write("a.txt", "one");
    const edited = await write("a.txt", "two");
    await undoEdit(company, workspace, { id: edited! }, "you");
    expect(await read("a.txt")).toBe("one");
    await undoEdit(company, workspace, { id: created! }, "you");
    expect(await present(path.join(files, "a.txt"))).toBe(false);

    await writeFile(path.join(files, "b.txt"), "keep me");
    const deleted = await remove("b.txt");
    await undoEdit(company, workspace, { id: deleted! }, "you");
    expect(await read("b.txt")).toBe("keep me");
  });

  it("refuses when the file changed afterwards, and leaves the newer text alone", async () => {
    const id = await write("a.txt", "one");
    await writeFile(path.join(files, "a.txt"), "typed by the person");
    await expect(undoEdit(company, workspace, { id: id! }, "you")).rejects.toThrow(/changed after that edit/);
    expect(await read("a.txt")).toBe("typed by the person");
  });

  it("refuses to restore a deleted file over a folder or a link put at its path since", async () => {
    await writeFile(path.join(files, "a.txt"), "one");
    const deletedFile = await remove("a.txt");
    await mkdir(path.join(files, "a.txt"));
    await expect(undoEdit(company, workspace, { id: deletedFile! }, "you")).rejects.toThrow(/changed after that edit/);

    await writeFile(path.join(files, "b.txt"), "two");
    const deletedLinked = await remove("b.txt");
    const outside = path.join(root, `outside-${workspace}.txt`);
    await symlink(outside, path.join(files, "b.txt"));
    await expect(undoEdit(company, workspace, { id: deletedLinked! }, "you")).rejects.toThrow(/changed after that edit/);
    expect(await present(outside)).toBe(false);
  });

  it("can undo an undo, after which the change it brought back can be undone again", async () => {
    await write("a.txt", "one");
    const second = await write("a.txt", "two");
    const undo = await undoEdit(company, workspace, { id: second! }, "you");
    expect(await read("a.txt")).toBe("one");
    await expect(undoEdit(company, workspace, { id: second! }, "you")).rejects.toThrow(/already undone/);

    const redo = await undoEdit(company, workspace, { id: undo.undo.id }, "you");
    expect(await read("a.txt")).toBe("two");
    expect((await listEdits(company, workspace)).find((entry) => entry.id === second)?.undoneBy).toBeUndefined();

    // Undoing the redo reverses the second write again, by the first undo.
    await undoEdit(company, workspace, { id: redo.undo.id }, "you");
    expect(await read("a.txt")).toBe("one");
    expect((await listEdits(company, workspace)).find((entry) => entry.id === second)?.undoneBy).toBe(undo.undo.id);
    await expect(undoEdit(company, workspace, { id: second! }, "you")).rejects.toThrow(/already undone/);
  });

  it("walks back by path past undos, including a change brought back by undoing its undo", async () => {
    await write("a.txt", "one");
    const second = await write("a.txt", "two");
    const undo = await undoEdit(company, workspace, { id: second! }, "you");
    await undoEdit(company, workspace, { id: undo.undo.id }, "you");
    expect(await read("a.txt")).toBe("two");

    await undoEdit(company, workspace, { path: "a.txt" }, "assistant");
    expect(await read("a.txt")).toBe("one");
    await undoEdit(company, workspace, { path: "./a.txt" }, "assistant");
    expect(await present(path.join(files, "a.txt"))).toBe(false);
    await expect(undoEdit(company, workspace, { path: "a.txt" }, "assistant")).rejects.toThrow(/No change to a.txt to undo/);
  });

  it("asks which change when given neither an id nor a path", async () => {
    await expect(undoEdit(company, workspace, {}, "assistant")).rejects.toThrow(/edit_id/);
  });

  it("keeps nothing for binary or very large text, and then never overwrites that file from an older change", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const none = { exists: false, text: null };
    expect(await recordEdit(company, workspace, { path: "big.txt", before: none, after: { exists: true, text: big }, by: "assistant" })).toBeNull();
    expect(await recordEdit(company, workspace, { path: "nul.txt", before: none, after: { exists: true, text: "a\0b" }, by: "assistant" })).toBeNull();
    expect(await recordEdit(company, workspace, { path: "bin.dat", before: { exists: true, text: null }, after: none, by: "assistant" })).toBeNull();
    expect(await listEdits(company, workspace)).toEqual([]);

    await write("data.txt", "small");
    expect(await write("data.txt", big)).toBeNull();
    await expect(undoEdit(company, workspace, { path: "data.txt" }, "assistant")).rejects.toThrow(/changed after that edit/);
    expect((await read("data.txt")).length).toBe(big.length);
  });

  it("keeps the newest 400 changes and drops the oldest with their saved text", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 402; i++) {
      ids.push((await recordEdit(company, workspace, { path: `f${i}.txt`, before: { exists: false, text: null }, after: { exists: true, text: String(i) }, by: "assistant" }))!);
    }
    const edits = await listEdits(company, workspace);
    expect(edits).toHaveLength(400);
    expect(edits[0]!.id).toBe(ids[2]);
    const saved = (await readdir(path.join(root, company, workspace, "meta", "edits"))).filter((name) => name !== "index.json");
    expect(saved).toHaveLength(400);
    await expect(undoEdit(company, workspace, { id: ids[0]! }, "you")).rejects.toThrow(/no longer kept/);
  });

  it("lets only one of two undos of the same change through at once", async () => {
    await write("a.txt", "one");
    const second = await write("a.txt", "two");
    const results = await Promise.allSettled([
      undoEdit(company, workspace, { id: second! }, "you (undo)"),
      undoEdit(company, workspace, { id: second! }, "assistant"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(String(refused?.reason)).toMatch(/already undone/);
    const edits = await listEdits(company, workspace);
    expect(edits.filter((entry) => entry.undoOf === second)).toHaveLength(1);
    expect(edits.find((entry) => entry.id === second)?.undoneBy).toBe(edits.find((entry) => entry.undoOf === second)?.id);
    expect(await read("a.txt")).toBe("one");
  });

  it("walks back two steps when two teammates undo the same file at once", async () => {
    await write("a.txt", "one");
    await write("a.txt", "two");
    await write("a.txt", "three");
    await Promise.all([
      undoEdit(company, workspace, { path: "a.txt" }, "teammate 1"),
      undoEdit(company, workspace, { path: "a.txt" }, "teammate 2"),
    ]);
    expect(await read("a.txt")).toBe("one");
  });

  it("keeps every change when teammates record at once, alongside an undo", async () => {
    const first = await write("shared.txt", "one");
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => write(`t${i}.txt`, `teammate ${i}`, `teammate ${i}`)),
      undoEdit(company, workspace, { id: first! }, "you"),
    ]);
    const edits = await listEdits(company, workspace);
    expect(edits).toHaveLength(22);
    expect(edits.find((entry) => entry.id === first)?.undoneBy).toBeTruthy();
  });

  it("refuses paths outside the project", async () => {
    await expect(undoEdit(company, workspace, { path: "../ws-other/files/a.txt" }, "assistant")).rejects.toThrow(/inside the project/);
    await expect(undoEdit(company, workspace, { path: "/etc/passwd" }, "assistant")).rejects.toThrow(/inside the project/);
  });

  it("keeps the log across a server restart", async () => {
    const id = await write("a.txt", "one");
    vi.resetModules();
    const fresh = await import("../services/studio/edits.js");
    expect((await fresh.listEdits(company, workspace)).map((entry) => entry.id)).toEqual([id]);
    await fresh.undoEdit(company, workspace, { id: id! }, "you");
    expect(await present(path.join(files, "a.txt"))).toBe(false);
  });
});
