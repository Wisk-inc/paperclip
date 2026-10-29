/**
 * Every file change the assistant makes in a Studio project, kept so it can
 * be reversed: by the person (the Undo beside the step) or by the assistant
 * itself (its undo_edit tool). A change is undone by putting back what was
 * there before, and only while the file still holds what the change left:
 * undoing an older change under a newer one would silently lose the newer
 * one. An undo is itself a recorded change, so it can be undone too.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { badRequest, conflict, notFound } from "../../errors.js";
import { deleteStudioEntry, normalizeStudioPath, readStudioFile, studioWorkspaceDirs, writeStudioFile } from "./files.js";

/** Text larger than this is not kept for undo (the change still happens). */
const MAX_TRACKED_BYTES = 2 * 1024 * 1024;
const MAX_EDITS = 400;

export interface StudioEditRecord {
  id: string;
  path: string;
  /** False when the file did not exist before (the change created it). */
  beforeExists: boolean;
  afterExists: boolean;
  at: string;
  /** Who made it: "assistant", a teammate's name, or "you (undo)". */
  by: string;
  /** Set on an undo: the change it reversed. */
  undoOf?: string;
  /** Set once undone: the undo that reversed it. */
  undoneBy?: string;
}

type FileState = { exists: boolean; text: string | null };
type EditChange = { path: string; before: FileState; after: FileState; by: string; undoOf?: string };
type EditDirs = ReturnType<typeof editDirs>;

function editDirs(companyId: string, workspaceId: string) {
  const { meta, files } = studioWorkspaceDirs(companyId, workspaceId);
  const base = path.join(meta, "edits");
  return { base, files, index: path.join(base, "index.json") };
}

async function readIndex(file: string): Promise<StudioEditRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as StudioEditRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(file: string, entries: StudioEditRecord[]) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(entries));
  await fs.rename(temp, file);
}

/** One change to the index at a time per project (teammates edit in parallel). */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

/** The file's text right now, or null when it does not exist (or is not text we can keep). */
export async function currentText(companyId: string, workspaceId: string, relative: string): Promise<FileState> {
  const { files } = editDirs(companyId, workspaceId);
  try {
    const file = await readStudioFile(files, relative);
    if (file.content === null || Buffer.byteLength(file.content) > MAX_TRACKED_BYTES) return { exists: true, text: null };
    return { exists: true, text: file.content };
  } catch {
    // A folder or a link at the path is still something there.
    const exists = await Promise.resolve()
      .then(() => fs.lstat(path.join(files, normalizeStudioPath(relative))))
      .then(() => true, () => false);
    return { exists, text: null };
  }
}

/** Whether one side of a change can be kept: text that reads back as the same text (not binary-looking, not too large). */
function keepable(state: FileState): boolean {
  if (!state.exists) return true;
  if (state.text === null) return false;
  const bytes = Buffer.from(state.text);
  return bytes.length <= MAX_TRACKED_BYTES && !bytes.subarray(0, 8000).includes(0);
}

async function saveText(dirs: EditDirs, change: EditChange): Promise<string> {
  const id = randomUUID();
  await fs.mkdir(dirs.base, { recursive: true });
  await fs.writeFile(path.join(dirs.base, `${id}.json`), JSON.stringify({ before: change.before.text, after: change.after.text }));
  return id;
}

/** Adds a change whose text is saved under `id` and writes the index; the caller holds the lock. */
async function appendEdit(dirs: EditDirs, entries: StudioEditRecord[], id: string, change: EditChange): Promise<StudioEditRecord> {
  const record: StudioEditRecord = {
    id,
    path: normalizeStudioPath(change.path),
    beforeExists: change.before.exists,
    afterExists: change.after.exists,
    at: new Date().toISOString(),
    by: change.by,
    ...(change.undoOf ? { undoOf: change.undoOf } : {}),
  };
  entries.push(record);
  const dropped = entries.length > MAX_EDITS ? entries.splice(0, entries.length - MAX_EDITS) : [];
  await writeIndex(dirs.index, entries);
  await Promise.all(dropped.map((entry) => fs.rm(path.join(dirs.base, `${entry.id}.json`), { force: true })));
  return record;
}

/**
 * Records one change. `before`/`after` are the file's text (null: it did not
 * exist). Returns null when the change cannot be kept for undo (binary or
 * very large text).
 */
export async function recordEdit(companyId: string, workspaceId: string, change: EditChange): Promise<string | null> {
  if (!keepable(change.before) || !keepable(change.after)) return null;
  const dirs = editDirs(companyId, workspaceId);
  const id = await saveText(dirs, change);
  await withLock(dirs.index, async () => appendEdit(dirs, await readIndex(dirs.index), id, change));
  return id;
}

export async function listEdits(companyId: string, workspaceId: string): Promise<StudioEditRecord[]> {
  return readIndex(editDirs(companyId, workspaceId).index);
}

/**
 * Undoes one change: by id, or the newest not-yet-undone change to `path`.
 * By path, undos themselves are skipped, so undoing again keeps walking back
 * through the file's history instead of redoing what was just undone.
 * Refuses when the file no longer holds what that change left.
 */
export async function undoEdit(
  companyId: string,
  workspaceId: string,
  target: { id?: string; path?: string },
  by: string,
): Promise<{ undone: StudioEditRecord; undo: StudioEditRecord }> {
  if (!target.id && !target.path) throw badRequest("Say which change to undo: its edit_id, or the file's path");
  const dirs = editDirs(companyId, workspaceId);
  const wantedPath = target.path ? normalizeStudioPath(target.path) : null;
  // All under the lock, so two undos at once can't both pass the checks.
  return withLock(dirs.index, async () => {
    const entries = await readIndex(dirs.index);
    const edit = target.id
      ? entries.find((entry) => entry.id === target.id)
      : [...entries].reverse().find((entry) => entry.path === wantedPath && !entry.undoneBy && !entry.undoOf);
    if (!edit) throw notFound(target.id ? "That change is no longer kept, so it can't be undone" : `No change to ${target.path} to undo`);
    if (edit.undoneBy) throw conflict("That change was already undone");
    const stored = JSON.parse(await fs.readFile(path.join(dirs.base, `${edit.id}.json`), "utf8").catch(() => "null")) as { before: string | null; after: string | null } | null;
    if (!stored) throw notFound("That change is no longer kept, so it can't be undone");
    const now = await currentText(companyId, workspaceId, edit.path);
    const stillAsLeft = edit.afterExists ? now.exists && now.text === stored.after : !now.exists;
    if (!stillAsLeft) {
      throw conflict(`${edit.path} changed after that edit, so undoing it would lose the newer changes. Undo the later change first, or edit the file directly.`);
    }
    if (edit.beforeExists) await writeStudioFile(dirs.files, edit.path, stored.before ?? "");
    else await deleteStudioEntry(dirs.files, edit.path);
    const change: EditChange = {
      path: edit.path,
      before: { exists: edit.afterExists, text: stored.after },
      after: { exists: edit.beforeExists, text: stored.before },
      by,
      undoOf: edit.id,
    };
    const undoId = await saveText(dirs, change);
    edit.undoneBy = undoId;
    // Undoing an undo brings back the change it reversed; down a chain of
    // undos of undos, every other change is reversed again.
    let link: StudioEditRecord | undefined = edit;
    let reversedBy: string | undefined;
    for (let steps = 0; link?.undoOf && steps < entries.length; steps++) {
      const wanted: string = link.undoOf;
      link = entries.find((entry) => entry.id === wanted);
      if (!link) break;
      if (reversedBy) link.undoneBy = reversedBy;
      else delete link.undoneBy;
      reversedBy = reversedBy ? undefined : link.id;
    }
    const undo = await appendEdit(dirs, entries, undoId, change);
    return { undone: { ...edit }, undo };
  });
}
