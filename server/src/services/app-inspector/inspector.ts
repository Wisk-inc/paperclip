import { exec, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { logger } from "../../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

/**
 * The App Inspector: decode an Android app with apktool so its manifest,
 * resources and code can be read (and, for your own apps, rebuilt). Everything
 * runs on the device Automa runs on; projects live under the instance root.
 *
 * This is a developer/analysis tool. It decodes and rebuilds; it carries
 * nothing aimed at defeating another app's licensing, DRM or anti-tamper.
 */

export type InspectorStatus = "decoding" | "ready" | "building" | "built" | "failed";

interface InspectorProject {
  id: string;
  companyId: string;
  label: string;
  dir: string;
  status: InspectorStatus;
  log: string;
  outputPath: string | null;
  error: string | null;
  createdAt: string;
}

const projects = new Map<string, InspectorProject>();
const MAX_LOG = 64 * 1024;
const MAX_FILE_READ = 2 * 1024 * 1024;

function inspectorRoot(): string {
  return path.join(resolvePaperclipInstanceRoot(), "app-inspector");
}

function decodedDir(project: InspectorProject): string {
  return path.join(project.dir, "decoded");
}

function scriptPath(): string {
  return fileURLToPath(new URL("../scripts/app-inspector/app-inspector.sh", import.meta.url));
}

function appendLog(project: InspectorProject, chunk: string) {
  project.log = (project.log + chunk).slice(-MAX_LOG);
}

/** Confine a relative path to a base directory; throws on escape. */
export function confineToBase(base: string, relative: string): string {
  const resolved = path.resolve(base, relative.replace(/^\/+/, ""));
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (resolved !== base && !resolved.startsWith(withSep)) {
    throw new Error("Path escapes the project");
  }
  return resolved;
}

/** Confine a project-relative path to the decoded tree; throws on escape. */
export function resolveInsideDecoded(project: InspectorProject, relative: string): string {
  return confineToBase(decodedDir(project), relative);
}

function publicView(project: InspectorProject) {
  return {
    id: project.id,
    label: project.label,
    status: project.status,
    outputPath: project.outputPath,
    error: project.error,
    createdAt: project.createdAt,
    logTail: project.log.slice(-8000),
  };
}

function runScript(project: InspectorProject, args: string[], onDone: (code: number) => void) {
  const child = spawn("bash", [scriptPath(), ...args], { cwd: project.dir });
  child.stdout.on("data", (buffer: Buffer) => appendLog(project, buffer.toString()));
  child.stderr.on("data", (buffer: Buffer) => appendLog(project, buffer.toString()));
  child.on("error", (error) => {
    appendLog(project, `\n[Automa] ${error instanceof Error ? error.message : String(error)}\n`);
    onDone(127);
  });
  child.on("exit", (code) => onDone(code ?? 1));
}

export function getInspectorProject(companyId: string, id: string): InspectorProject | null {
  const project = projects.get(id);
  return project && project.companyId === companyId ? project : null;
}

export function listInspectorProjects(companyId: string) {
  return [...projects.values()].filter((project) => project.companyId === companyId).map(publicView);
}

export { publicView as inspectorProjectView };

/** Start decoding an APK at a device path into a new project. */
export async function startDecode(input: { companyId: string; apkPath: string; label: string }) {
  if (!existsSync(input.apkPath)) throw new Error("That APK file was not found on this device.");
  const id = randomUUID();
  const dir = path.join(inspectorRoot(), id);
  await fs.mkdir(dir, { recursive: true });
  const localApk = path.join(dir, "input.apk");
  await fs.copyFile(input.apkPath, localApk);
  const project: InspectorProject = {
    id,
    companyId: input.companyId,
    label: input.label || path.basename(input.apkPath),
    dir,
    status: "decoding",
    log: "",
    outputPath: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  projects.set(id, project);
  runScript(project, ["decode", localApk, decodedDir(project)], (code) => {
    if (code === 0 && existsSync(decodedDir(project))) {
      project.status = "ready";
    } else {
      project.status = "failed";
      project.error = "apktool could not decode this APK. See the log.";
    }
  });
  return publicView(project);
}

/** Rebuild the (edited) project into a signed APK saved to Downloads. */
export function startRebuild(companyId: string, id: string) {
  const project = getInspectorProject(companyId, id);
  if (!project) throw new Error("Project not found");
  if (project.status === "decoding" || project.status === "building") throw new Error("Still working; wait for it to finish.");
  project.status = "building";
  project.error = null;
  project.outputPath = null;
  const outName = `${project.label.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.apk$/i, "") || "app"}-automa.apk`;
  runScript(project, ["rebuild", decodedDir(project), outName], (code) => {
    const marker = /\[OUTPUT\] (.+)\n/.exec(project.log);
    if (code === 0 && marker) {
      project.status = "built";
      project.outputPath = marker[1]!.trim();
    } else {
      project.status = "failed";
      project.error = "apktool could not rebuild this project. See the log.";
    }
  });
  return publicView(project);
}

export interface InspectorFileNode {
  name: string;
  path: string;
  dir: boolean;
}

/** One directory level of the decoded tree. */
export async function listInspectorDir(companyId: string, id: string, relative: string): Promise<InspectorFileNode[]> {
  const project = getInspectorProject(companyId, id);
  if (!project) throw new Error("Project not found");
  const dir = resolveInsideDecoded(project, relative || ".");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .map((entry) => ({
      name: entry.name,
      path: path.posix.join(relative.replace(/^\/+/, ""), entry.name),
      dir: entry.isDirectory(),
    }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

export async function readInspectorFile(companyId: string, id: string, relative: string): Promise<{ text: string; truncated: boolean }> {
  const project = getInspectorProject(companyId, id);
  if (!project) throw new Error("Project not found");
  const file = resolveInsideDecoded(project, relative);
  const stat = await fs.stat(file);
  if (stat.isDirectory()) throw new Error("That is a folder");
  const handle = await fs.open(file, "r");
  try {
    const length = Math.min(stat.size, MAX_FILE_READ);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    if (buffer.includes(0)) return { text: "[binary file — open it after rebuild, or on your computer]", truncated: false };
    return { text: buffer.toString("utf8"), truncated: stat.size > MAX_FILE_READ };
  } finally {
    await handle.close();
  }
}

export async function writeInspectorFile(companyId: string, id: string, relative: string, text: string): Promise<void> {
  const project = getInspectorProject(companyId, id);
  if (!project) throw new Error("Project not found");
  if (text.length > MAX_FILE_READ) throw new Error("That file is too large to save from here.");
  const file = resolveInsideDecoded(project, relative);
  const stat = await fs.stat(file).catch(() => null);
  if (stat?.isDirectory()) throw new Error("That is a folder");
  await fs.writeFile(file, text, "utf8");
}

export async function deleteInspectorProject(companyId: string, id: string): Promise<boolean> {
  const project = getInspectorProject(companyId, id);
  if (!project) return false;
  projects.delete(id);
  await fs.rm(project.dir, { recursive: true, force: true }).catch((error) =>
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "inspector project cleanup failed"),
  );
  return true;
}

/** Test-only. */
export function __resetInspector(): void {
  projects.clear();
}

const run = promisify(exec);

function onPhone(): boolean {
  return process.platform === "android" || (process.env.PREFIX ?? "").includes("com.termux");
}

export async function inspectorStatus(): Promise<{ kind: "phone" | "computer"; apktoolReady: boolean }> {
  let apktoolReady = false;
  try {
    await run("command -v apktool", { shell: process.env.SHELL || "/bin/sh", timeout: 5000 });
    apktoolReady = true;
  } catch {
    apktoolReady = false;
  }
  return { kind: onPhone() ? "phone" : "computer", apktoolReady };
}

/** The user-installed apps on this phone (package names). Empty off-phone. */
export async function listInstalledApps(): Promise<string[]> {
  if (!onPhone()) return [];
  try {
    const { stdout } = await run("pm list packages -3", { timeout: 15000 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/^package:/, "").trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/** The APK path of an installed package, copied somewhere readable if needed. */
export async function resolveInstalledApkPath(pkg: string): Promise<string> {
  if (!/^[A-Za-z0-9_.]+$/.test(pkg)) throw new Error("That is not a package name.");
  const { stdout } = await run(`pm path ${pkg}`, { timeout: 10000 });
  const base = stdout.split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).find((l) => l.endsWith("base.apk") || l.endsWith(".apk"));
  if (!base) throw new Error("Could not find that app's APK on this device.");
  return base;
}
