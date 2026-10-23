import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { StudioFileContent, StudioFileNode } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { badRequest, conflict, notFound } from "../../errors.js";

/** Largest file the editor opens as text. */
export const STUDIO_MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Installed dependencies and caches: shown collapsed and never listed. */
const DEPENDENCY_FOLDERS = new Set(["node_modules", ".venv", "venv", "__pycache__", ".gradle", ".next", ".cache"]);
/**
 * Build output. These names are also people's own folders (a `bin/cli.js`, a
 * `build/build.sh`), so they are listed unless they hold a lot.
 */
const OUTPUT_FOLDERS = new Set(["target", "build", "dist", "bin", "obj"]);
const MAX_OUTPUT_FOLDER_ENTRIES = 200;
const MAX_TREE_ENTRIES = 5000;

/** True when the folder holds more than `limit` entries (it stops counting there). */
async function holdsMoreThan(dir: string, limit: number): Promise<boolean> {
  let seen = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      seen += 1;
      if (seen > limit) return true;
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

export function studioRoot(): string {
  const override = process.env.PAPERCLIP_STUDIO_DIR?.trim();
  return override ? path.resolve(override) : path.resolve(resolvePaperclipInstanceRoot(), "studio");
}

/** Where one workspace keeps its project files and its own bookkeeping. */
export function studioWorkspaceDirs(companyId: string, workspaceId: string) {
  const base = path.join(studioRoot(), safeSegment(companyId), safeSegment(workspaceId));
  return { base, files: path.join(base, "files"), meta: path.join(base, "meta") };
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw badRequest("Invalid id");
  return value;
}

/** Normalizes a project-relative path ("src/app.js"), refusing anything that leaves the project. */
export function normalizeStudioPath(input: string): string {
  const cleaned = input.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (!cleaned || cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) throw badRequest("Use a path inside the project");
  const parts = cleaned.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) throw badRequest("Use a path inside the project");
  if (parts.some((part) => part.length > 255 || /[\0]/.test(part))) throw badRequest("That file name is not allowed");
  return parts.join("/");
}

/**
 * The absolute path for a project-relative path, after checking that neither
 * it nor any existing parent folder (through symlinks) leads outside `root`.
 */
export async function resolveInside(root: string, relative: string): Promise<string> {
  const normalized = normalizeStudioPath(relative);
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(root + path.sep)) throw badRequest("Use a path inside the project");
  const realRoot = await fs.realpath(root);
  // Check the deepest part of the path that exists.
  let probe = target;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw badRequest("That path points outside the project");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}

export function contentVersion(content: Buffer | string, mtimeMs: number): string {
  return `${createHash("sha256").update(content).digest("hex").slice(0, 16)}-${Math.round(mtimeMs)}`;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

export async function listTree(root: string): Promise<StudioFileNode[]> {
  let count = 0;
  async function walk(dir: string, relative: string, depth: number): Promise<StudioFileNode[]> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const nodes: StudioFileNode[] = [];
    for (const entry of entries) {
      if (count >= MAX_TREE_ENTRIES) break;
      count += 1;
      const childPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const full = path.join(dir, entry.name);
        const reason: StudioFileNode["unlistedReason"] | null =
          entry.name === ".git"
            ? "git"
            : DEPENDENCY_FOLDERS.has(entry.name)
              ? "dependencies"
              : depth > 12
                ? "deep"
                : OUTPUT_FOLDERS.has(entry.name) && (await holdsMoreThan(full, MAX_OUTPUT_FOLDER_ENTRIES))
                  ? "large"
                  : null;
        nodes.push({
          name: entry.name,
          path: childPath,
          type: "folder",
          children: reason ? [] : await walk(full, childPath, depth + 1),
          ...(reason ? { unlisted: true, unlistedReason: reason } : {}),
        });
      } else if (entry.isFile()) {
        const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        nodes.push({
          name: entry.name,
          path: childPath,
          type: "file",
          size: stat?.size ?? 0,
          ...(stat ? { modifiedAt: stat.mtime.toISOString() } : {}),
        });
      }
    }
    return nodes;
  }
  return walk(root, "", 0);
}

/** Every text file path, for the assistant's overview (skips heavy folders). */
export async function listFilePaths(root: string, limit = 400): Promise<string[]> {
  const out: string[] = [];
  const visit = (nodes: StudioFileNode[]) => {
    for (const node of nodes) {
      if (out.length >= limit) return;
      if (node.type === "file") out.push(node.path);
      else if (node.children) visit(node.children);
    }
  };
  visit(await listTree(root));
  return out;
}

export async function readStudioFile(root: string, relative: string): Promise<StudioFileContent> {
  const target = await resolveInside(root, relative);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat || !stat.isFile()) throw notFound("File not found");
  const normalized = normalizeStudioPath(relative);
  if (stat.size > STUDIO_MAX_TEXT_BYTES) {
    return { path: normalized, content: null, size: stat.size, binary: false, version: `${stat.size}-${Math.round(stat.mtimeMs)}` };
  }
  const buffer = await fs.readFile(target);
  const binary = looksBinary(buffer);
  return {
    path: normalized,
    content: binary ? null : buffer.toString("utf8"),
    size: stat.size,
    binary,
    version: contentVersion(buffer, stat.mtimeMs),
  };
}

export async function writeStudioFile(root: string, relative: string, content: string, baseVersion?: string | null) {
  const target = await resolveInside(root, relative);
  if (baseVersion) {
    const current = await readStudioFile(root, relative).catch(() => null);
    if (current && current.version !== baseVersion) {
      throw conflict("This file changed since you opened it", { code: "studio_file_changed", version: current.version, content: current.content });
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return readStudioFile(root, relative);
}

export async function createStudioEntry(root: string, relative: string, type: "file" | "folder") {
  const target = await resolveInside(root, relative);
  const exists = await fs.stat(target).then(() => true, () => false);
  if (exists) throw conflict("Something with that name already exists");
  if (type === "folder") {
    await fs.mkdir(target, { recursive: true });
  } else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "", { flag: "wx" });
  }
}

export async function moveStudioEntry(root: string, from: string, to: string) {
  const source = await resolveInside(root, from);
  const destination = await resolveInside(root, to);
  if (!(await fs.stat(source).then(() => true, () => false))) throw notFound("Nothing to move at that path");
  if (await fs.stat(destination).then(() => true, () => false)) throw conflict("Something with that name already exists");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
}

export async function deleteStudioEntry(root: string, relative: string) {
  const target = await resolveInside(root, relative);
  if (target === root) throw badRequest("You can't delete the whole project here");
  await fs.rm(target, { recursive: true, force: true });
}

/** Saves an uploaded file into the project (into `folder`, keeping its name). */
export async function saveUploadedFile(root: string, folder: string | null, fileName: string, data: Buffer): Promise<string> {
  const name = path.basename(fileName).replace(/[\0/\\]/g, "_").slice(0, 200) || "upload";
  const relative = folder ? `${normalizeStudioPath(folder)}/${name}` : name;
  const target = await resolveInside(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  return normalizeStudioPath(relative);
}

/**
 * Moves an upload that multer wrote to a temporary file into the project.
 * Uploads used to be held in memory (up to 30 files of 50 MB each), which a
 * phone can't spare.
 */
export async function saveUploadedTempFile(root: string, folder: string | null, fileName: string, tempPath: string): Promise<string> {
  const name = path.basename(fileName).replace(/[\0/\\]/g, "_").slice(0, 200) || "upload";
  const relative = folder ? `${normalizeStudioPath(folder)}/${name}` : name;
  const target = await resolveInside(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(tempPath, target);
  } catch {
    // The temporary folder can be on another file system.
    await fs.copyFile(tempPath, target);
    await fs.rm(tempPath, { force: true });
  }
  return normalizeStudioPath(relative);
}

export async function writeStarterFiles(root: string, files: Readonly<Record<string, string>>) {
  for (const [relative, content] of Object.entries(files)) {
    const target = await resolveInside(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}
