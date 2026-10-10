import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Zip, ZipDeflate } from "fflate";
import type { StudioCheckpoint } from "@paperclipai/shared";
import { notFound } from "../../errors.js";
import { resolveInside, studioWorkspaceDirs } from "./files.js";

/**
 * Folders a snapshot or a download leaves out: installed dependencies,
 * version control, and caches the project can rebuild.
 */
const SKIPPED = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".gradle", ".next", ".cache", "target", "obj", ".dart_tool", ".pub-cache"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 60 * 1024 * 1024;
const MAX_CHECKPOINTS = 30;

interface IndexEntry extends StudioCheckpoint {}

function checkpointDirs(companyId: string, workspaceId: string) {
  const { meta, files } = studioWorkspaceDirs(companyId, workspaceId);
  const base = path.join(meta, "checkpoints");
  return { base, files, index: path.join(base, "index.json") };
}

async function readIndex(file: string): Promise<IndexEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as IndexEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(file: string, entries: IndexEntry[]) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(entries, null, 1));
  await fs.rename(temp, file);
}

/** Every regular file under `root` (relative paths), skipping heavy folders and symlinks. */
export async function walkProjectFiles(root: string, start = ""): Promise<Array<{ relative: string; size: number }>> {
  const out: Array<{ relative: string; size: number }> = [];
  async function visit(dir: string, relative: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await visit(childPath, childRelative);
      } else if (entry.isFile()) {
        const stat = await fs.stat(childPath).catch(() => null);
        if (stat) out.push({ relative: childRelative, size: stat.size });
      }
    }
  }
  const startDir = start ? await resolveInside(root, start) : root;
  const stat = await fs.lstat(startDir).catch(() => null);
  if (!stat) throw notFound("Nothing at that path");
  if (stat.isFile()) return [{ relative: start, size: stat.size }];
  await visit(startDir, start);
  return out;
}

async function copyInto(sourceRoot: string, destRoot: string, files: Array<{ relative: string; size: number }>, limit = true) {
  let bytes = 0;
  let copied = 0;
  let skipped = 0;
  for (const file of files) {
    if (limit && (file.size > MAX_FILE_BYTES || bytes + file.size > MAX_SNAPSHOT_BYTES)) {
      skipped += 1;
      continue;
    }
    const target = path.join(destRoot, file.relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, file.relative), target);
    bytes += file.size;
    copied += 1;
  }
  return { bytes, copied, skipped };
}

export async function listCheckpoints(companyId: string, workspaceId: string): Promise<StudioCheckpoint[]> {
  const dirs = checkpointDirs(companyId, workspaceId);
  return (await readIndex(dirs.index)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Saves a copy of the project's files (not dependencies) to come back to later. */
export async function createCheckpoint(
  companyId: string,
  workspaceId: string,
  input: { label: string; kind: StudioCheckpoint["kind"]; by: string },
): Promise<StudioCheckpoint> {
  const dirs = checkpointDirs(companyId, workspaceId);
  const id = randomUUID();
  const snapshot = path.join(dirs.base, id);
  await fs.mkdir(snapshot, { recursive: true });
  const files = await walkProjectFiles(dirs.files).catch(() => []);
  const result = await copyInto(dirs.files, snapshot, files);
  const entry: StudioCheckpoint = {
    id,
    label: input.label.slice(0, 160),
    kind: input.kind,
    by: input.by,
    fileCount: result.copied,
    bytes: result.bytes,
    skippedFiles: result.skipped,
    createdAt: new Date().toISOString(),
  };
  const index = await readIndex(dirs.index);
  index.push(entry);
  index.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const removed = index.splice(MAX_CHECKPOINTS);
  await writeIndex(dirs.index, index);
  for (const old of removed) await fs.rm(path.join(dirs.base, old.id), { recursive: true, force: true });
  return entry;
}

/**
 * Puts the project's files back the way they were at a checkpoint. The
 * current files are saved as a checkpoint first, so a restore can be undone.
 * Dependencies (node_modules and similar) are left alone.
 */
export async function restoreCheckpoint(companyId: string, workspaceId: string, checkpointId: string, by: string) {
  const dirs = checkpointDirs(companyId, workspaceId);
  const index = await readIndex(dirs.index);
  const target = index.find((entry) => entry.id === checkpointId);
  if (!target || !/^[0-9a-f-]{36}$/.test(checkpointId)) throw notFound("Checkpoint not found");
  const snapshot = path.join(dirs.base, checkpointId);
  const safety = await createCheckpoint(companyId, workspaceId, { label: `Before going back to “${target.label}”`, kind: "restore", by });
  const entries = await fs.readdir(dirs.files, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED.has(entry.name)) continue;
    await fs.rm(path.join(dirs.files, entry.name), { recursive: true, force: true });
  }
  await fs.mkdir(dirs.files, { recursive: true });
  const files = await walkProjectFiles(snapshot);
  await copyInto(snapshot, dirs.files, files, false);
  return { restored: target, safety };
}

export async function deleteCheckpoint(companyId: string, workspaceId: string, checkpointId: string) {
  const dirs = checkpointDirs(companyId, workspaceId);
  const index = await readIndex(dirs.index);
  const next = index.filter((entry) => entry.id !== checkpointId);
  if (next.length === index.length) throw notFound("Checkpoint not found");
  await writeIndex(dirs.index, next);
  await fs.rm(path.join(dirs.base, checkpointId), { recursive: true, force: true });
}

/**
 * Streams a zip of the project (or one folder or file in it) to `write`,
 * without dependencies, version control, or symlinks.
 */
export async function streamProjectZip(
  root: string,
  relative: string,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  const files = await walkProjectFiles(root, relative);
  // Names inside the zip start at the chosen folder ("src/app.js" for "src").
  const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/") + 1) : "";
  let pending: Promise<void> = Promise.resolve();
  let failure: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else pending = pending.then(() => write(chunk));
  });
  for (const file of files) {
    if (failure) throw failure;
    const entry = new ZipDeflate(file.relative.slice(parent.length), { level: 6 });
    zip.add(entry);
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path.join(root, file.relative));
      stream.on("data", (chunk) => entry.push(new Uint8Array(chunk as Buffer), false));
      stream.on("end", () => {
        entry.push(new Uint8Array(0), true);
        resolve();
      });
      stream.on("error", reject);
    });
    await pending;
  }
  zip.end();
  await pending;
  if (failure) throw failure;
  return files.length;
}
