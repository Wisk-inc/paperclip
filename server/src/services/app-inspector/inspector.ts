import { exec, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, createWriteStream, existsSync, promises as fs, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { logger } from "../../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

/**
 * The App Inspector: decode an Android app with apktool so its manifest,
 * resources and smali can be read and edited, decompile its code to Java with
 * jadx so it reads like source, and rebuild a signed APK. Everything runs on
 * the device Automa runs on; projects live under the instance root and survive
 * a restart.
 *
 * This is a developer/analysis tool. It decodes and rebuilds; it carries
 * nothing aimed at defeating another app's licensing, DRM or anti-tamper.
 */

export type InspectorStatus = "decoding" | "ready" | "building" | "built" | "failed";
export type InspectorJavaStatus = "none" | "working" | "ready" | "failed";
/** `files` is the apktool tree (editable, rebuilt); `java` is jadx's read-only Java. */
export type InspectorView = "files" | "java";

/** What to decode, like apktool's -r / -s switches, plus jadx. */
export interface DecodeOptions {
  /** Decode resources.arsc into res/ (off: faster, the rebuild keeps the original resources). */
  resources: boolean;
  /** Disassemble classes.dex into smali (off: the rebuild keeps the original code). */
  sources: boolean;
  /** Decompile the code to Java with jadx (read-only). */
  java: boolean;
}

export const DEFAULT_DECODE_OPTIONS: DecodeOptions = { resources: true, sources: true, java: true };

interface InspectorProject {
  id: string;
  companyId: string;
  label: string;
  packageName: string | null;
  /** Split APKs the app was installed with besides base.apk; a rebuild has only the base. */
  splitCount: number;
  options: DecodeOptions;
  dir: string;
  status: InspectorStatus;
  /** The apktool tree exists, so files can be browsed even after a failed rebuild. */
  decoded: boolean;
  java: InspectorJavaStatus;
  log: string;
  /** The rebuilt APK inside the project (served by the output route). */
  outputPath: string | null;
  /** Where the rebuild was also copied, when the device's Downloads folder was writable. */
  downloadsPath: string | null;
  error: string | null;
  createdAt: string;
}

const projects = new Map<string, InspectorProject>();
const running = new Map<string, Set<ChildProcess>>();
let loaded = false;
const MAX_LOG = 64 * 1024;
const MAX_FILE_READ = 2 * 1024 * 1024;
/** The largest APK the inspector accepts from an upload. */
export const MAX_APK_BYTES = 1024 * 1024 * 1024;

function inspectorRoot(): string {
  return path.join(resolvePaperclipInstanceRoot(), "app-inspector");
}

function decodedDir(project: InspectorProject): string {
  return path.join(project.dir, "decoded");
}

function javaDir(project: InspectorProject): string {
  return path.join(project.dir, "java");
}

function inputApk(project: InspectorProject): string {
  return path.join(project.dir, "input.apk");
}

function viewRoot(project: InspectorProject, view: InspectorView): string {
  // jadx writes code under sources/; show that as the root of the Java view.
  return view === "java" ? path.join(javaDir(project), "sources") : decodedDir(project);
}

function scriptPath(): string {
  return fileURLToPath(new URL("../scripts/app-inspector/app-inspector.sh", import.meta.url));
}

function appendLog(project: InspectorProject, chunk: string) {
  project.log = (project.log + chunk).slice(-MAX_LOG);
}

const PERSISTED_KEYS = [
  "id", "companyId", "label", "packageName", "splitCount", "options", "status", "decoded", "java", "outputPath", "downloadsPath", "error", "createdAt",
] as const;

function persist(project: InspectorProject) {
  const meta = Object.fromEntries(PERSISTED_KEYS.map((key) => [key, project[key]]));
  try {
    writeFileSync(path.join(project.dir, "project.json"), JSON.stringify(meta, null, 2));
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "inspector project save failed");
  }
}

/** Projects outlive the server: read them back the first time they're needed. */
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const root = inspectorRoot();
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || projects.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, "project.json"), "utf8")) as Partial<InspectorProject>;
      if (!meta.id || meta.id !== entry.name || !meta.companyId) continue;
      const project: InspectorProject = {
        id: meta.id,
        companyId: meta.companyId,
        label: meta.label || "app",
        packageName: meta.packageName ?? null,
        splitCount: meta.splitCount ?? 0,
        options: { ...DEFAULT_DECODE_OPTIONS, ...(meta.options ?? {}) },
        dir,
        status: meta.status ?? "failed",
        decoded: existsSync(path.join(dir, "decoded")),
        java: meta.java ?? "none",
        log: "",
        outputPath: meta.outputPath && existsSync(meta.outputPath) ? meta.outputPath : null,
        downloadsPath: meta.downloadsPath ?? null,
        error: meta.error ?? null,
        createdAt: meta.createdAt ?? new Date().toISOString(),
      };
      // Work that was running when Automa stopped did not finish.
      if (project.status === "decoding") {
        project.status = "failed";
        project.decoded = false;
        project.error = "Automa stopped before decoding finished. Delete this one and decode the app again.";
      } else if (project.status === "building") {
        project.status = project.decoded ? "ready" : "failed";
        project.error = "Automa stopped before the rebuild finished. Rebuild again.";
      } else if (project.status === "built" && !project.outputPath) {
        project.status = "ready";
      }
      if (project.java === "working") project.java = "failed";
      projects.set(project.id, project);
    } catch {
      // Not a project folder (or a half-written one); leave it alone.
    }
  }
}

function publicView(project: InspectorProject) {
  return {
    id: project.id,
    label: project.label,
    packageName: project.packageName,
    // Where the decoded files live on this device, for agents with file tools.
    dir: project.dir,
    splitCount: project.splitCount,
    options: project.options,
    status: project.status,
    decoded: project.decoded,
    java: project.java,
    hasOutput: Boolean(project.outputPath),
    outputName: project.outputPath ? path.basename(project.outputPath) : null,
    downloadsPath: project.downloadsPath,
    error: project.error,
    createdAt: project.createdAt,
    logTail: project.log.slice(-8000),
  };
}

export { publicView as inspectorProjectView };

/** Run the helper script; `onDone` gets the exit code and this run's own output. */
function runScript(project: InspectorProject, args: string[], onDone: (code: number, output: string) => void) {
  const child = spawn("bash", [scriptPath(), ...args], { cwd: project.dir });
  const set = running.get(project.id) ?? new Set<ChildProcess>();
  set.add(child);
  running.set(project.id, set);
  let finished = false;
  let output = "";
  const record = (chunk: string) => {
    appendLog(project, chunk);
    output = (output + chunk).slice(-MAX_LOG);
  };
  const done = (code: number) => {
    if (finished) return;
    finished = true;
    set.delete(child);
    if (set.size === 0) running.delete(project.id);
    // A deleted project's late exit must not resurrect it.
    if (projects.get(project.id) !== project) return;
    onDone(code, output);
    persist(project);
  };
  child.stdout.on("data", (buffer: Buffer) => record(buffer.toString()));
  child.stderr.on("data", (buffer: Buffer) => record(buffer.toString()));
  child.on("error", (error) => {
    record(`\n[Automa] ${error instanceof Error ? error.message : String(error)}\n`);
    done(127);
  });
  child.on("close", (code) => done(code ?? 1));
}

export function getInspectorProject(companyId: string, id: string): InspectorProject | null {
  ensureLoaded();
  const project = projects.get(id);
  return project && project.companyId === companyId ? project : null;
}

export function listInspectorProjects(companyId: string) {
  ensureLoaded();
  return [...projects.values()]
    .filter((project) => project.companyId === companyId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicView);
}

async function assertApk(file: string) {
  const handle = await fs.open(file, "r");
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    // APKs are zip archives: "PK\x03\x04".
    if (magic.readUInt32LE(0) !== 0x04034b50) throw new Error("That file isn't an APK (it isn't a zip archive).");
  } finally {
    await handle.close();
  }
}

interface NewProjectInput {
  companyId: string;
  label: string;
  packageName?: string | null;
  splitCount?: number;
  options?: Partial<DecodeOptions>;
}

async function newProjectDir(): Promise<{ id: string; dir: string }> {
  ensureLoaded();
  const id = randomUUID();
  const dir = path.join(inspectorRoot(), id);
  await fs.mkdir(dir, { recursive: true });
  return { id, dir };
}

function registerAndDecode(id: string, dir: string, input: NewProjectInput) {
  const project: InspectorProject = {
    id,
    companyId: input.companyId,
    label: input.label.trim().slice(0, 200) || "app",
    packageName: input.packageName ?? null,
    splitCount: Math.max(0, Math.min(input.splitCount ?? 0, 999)),
    options: { ...DEFAULT_DECODE_OPTIONS, ...(input.options ?? {}) },
    dir,
    status: "decoding",
    decoded: false,
    java: "none",
    log: "",
    outputPath: null,
    downloadsPath: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  projects.set(id, project);
  persist(project);
  const flags = [...(project.options.resources ? [] : ["--no-res"]), ...(project.options.sources ? [] : ["--no-src"])];
  // jadx reads the APK on its own, so it runs alongside apktool instead of
  // after it: the Java view is ready about as soon as the file tree is.
  if (project.options.java) startJava(project);
  runScript(project, ["decode", inputApk(project), decodedDir(project), ...flags], (code) => {
    if (code === 0 && existsSync(decodedDir(project))) {
      project.status = "ready";
      project.decoded = true;
    } else {
      project.status = "failed";
      project.error = "apktool could not decode this APK. See the log.";
    }
  });
  return publicView(project);
}

/** Decompile the code to Java with jadx, after apktool, so it reads like source. */
function startJava(project: InspectorProject) {
  project.java = "working";
  runScript(project, ["java", inputApk(project), javaDir(project)], (code) => {
    project.java = code === 0 && existsSync(viewRoot(project, "java")) ? "ready" : "failed";
  });
}

/** Start decoding an APK at a path on this device into a new project. */
export async function startDecode(input: NewProjectInput & { apkPath: string }) {
  try {
    await fs.access(input.apkPath, fsConstants.R_OK);
  } catch {
    throw new Error("Automa can't read that APK on this device.");
  }
  if ((await fs.stat(input.apkPath)).isDirectory()) throw new Error("That is a folder, not an APK.");
  await assertApk(input.apkPath);
  const { id, dir } = await newProjectDir();
  try {
    await fs.copyFile(input.apkPath, path.join(dir, "input.apk"));
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
  return registerAndDecode(id, dir, { ...input, label: input.label || path.basename(input.apkPath) });
}

/** Start decoding an APK sent in a request body (the app picker, or a chosen file). */
export async function startDecodeFromStream(input: NewProjectInput & { stream: Readable; maxBytes?: number }) {
  const limit = input.maxBytes ?? MAX_APK_BYTES;
  const { id, dir } = await newProjectDir();
  const target = path.join(dir, "input.apk");
  let received = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > limit) callback(new Error(`That APK is larger than ${Math.round(limit / (1024 * 1024))} MB.`));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(input.stream, cap, createWriteStream(target));
    if (received === 0) throw new Error("No APK arrived.");
    await assertApk(target);
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
  return registerAndDecode(id, dir, input);
}

/** Rebuild the (edited) project into a signed APK, also copied to Downloads when it can be. */
export function startRebuild(companyId: string, id: string) {
  const project = getInspectorProject(companyId, id);
  if (!project) throw new Error("Project not found");
  if (!project.decoded) throw new Error("This app was not decoded, so there is nothing to rebuild.");
  if (project.status === "decoding" || project.status === "building") throw new Error("Still working; wait for it to finish.");
  project.status = "building";
  project.error = null;
  project.outputPath = null;
  project.downloadsPath = null;
  persist(project);
  const outName = `${project.label.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.apk$/i, "").slice(0, 80) || "app"}-automa.apk`;
  runScript(project, ["rebuild", decodedDir(project), outName], (code, output) => {
    const built = /\[OUTPUT\] (.+)\n/.exec(output);
    const copied = /\[DOWNLOADS\] (.+)\n/.exec(output);
    if (code === 0 && built && existsSync(built[1]!.trim())) {
      project.status = "built";
      project.outputPath = built[1]!.trim();
      project.downloadsPath = copied ? copied[1]!.trim() : null;
    } else {
      project.status = "failed";
      project.error = "apktool could not rebuild this project. See the log, fix the file it names, and rebuild.";
    }
  });
  return publicView(project);
}

/** The rebuilt APK of a project, for the download route. */
export function inspectorOutputFile(companyId: string, id: string): { file: string; name: string } | null {
  const project = getInspectorProject(companyId, id);
  if (!project?.outputPath || !existsSync(project.outputPath)) return null;
  return { file: project.outputPath, name: path.basename(project.outputPath) };
}

export interface InspectorFileNode {
  name: string;
  path: string;
  dir: boolean;
  size: number | null;
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

/** Confine a project-relative path to one view's tree; throws on escape. */
function resolveInView(project: InspectorProject, view: InspectorView, relative: string): string {
  return confineToBase(viewRoot(project, view), relative);
}

function readyProject(companyId: string, id: string, view: InspectorView): InspectorProject {
  const project = getInspectorProject(companyId, id);
  if (!project) throw new Error("Project not found");
  if (view === "files" && !project.decoded) throw new Error("This app is not decoded yet.");
  if (view === "java" && project.java !== "ready") {
    throw new Error(project.java === "working" ? "Still decompiling to Java; try again in a moment." : "There is no Java for this app.");
  }
  return project;
}

/** One directory level of a project tree. */
export async function listInspectorDir(companyId: string, id: string, relative: string, view: InspectorView = "files"): Promise<InspectorFileNode[]> {
  const project = readyProject(companyId, id, view);
  const dir = resolveInView(project, view, relative || ".");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const base = relative.replace(/^\/+/, "");
  const nodes = await Promise.all(
    entries.map(async (entry) => ({
      name: entry.name,
      path: path.posix.join(base, entry.name),
      dir: entry.isDirectory(),
      size: entry.isFile() ? await fs.stat(path.join(dir, entry.name)).then((s) => s.size, () => null) : null,
    })),
  );
  return nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

export interface InspectorFileContent {
  text: string;
  truncated: boolean;
  binary: boolean;
  /** Java is decompiled output; binary and truncated files would be damaged by a save. */
  readOnly: boolean;
}

export async function readInspectorFile(companyId: string, id: string, relative: string, view: InspectorView = "files"): Promise<InspectorFileContent> {
  const project = readyProject(companyId, id, view);
  const file = resolveInView(project, view, relative);
  const stat = await fs.stat(file);
  if (stat.isDirectory()) throw new Error("That is a folder");
  const handle = await fs.open(file, "r");
  try {
    const length = Math.min(stat.size, MAX_FILE_READ);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    if (buffer.includes(0)) {
      return { text: "", truncated: false, binary: true, readOnly: true };
    }
    const truncated = stat.size > MAX_FILE_READ;
    return { text: buffer.toString("utf8"), truncated, binary: false, readOnly: view === "java" || truncated };
  } finally {
    await handle.close();
  }
}

export async function writeInspectorFile(companyId: string, id: string, relative: string, text: string): Promise<void> {
  const project = readyProject(companyId, id, "files");
  if (project.status === "building") throw new Error("Wait for the rebuild to finish before saving.");
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_READ) throw new Error("That file is too large to save from here.");
  const file = resolveInView(project, "files", relative);
  const stat = await fs.stat(file).catch(() => null);
  if (stat?.isDirectory()) throw new Error("That is a folder");
  if (stat) {
    // Never overwrite what the editor could not show whole.
    if (stat.size > MAX_FILE_READ) throw new Error("That file is too large to edit here.");
    const head = Buffer.alloc(Math.min(stat.size, 8192));
    const handle = await fs.open(file, "r");
    try {
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
    if (head.includes(0)) throw new Error("That is a binary file; it can't be edited as text.");
  }
  await fs.writeFile(file, text, "utf8");
}

export async function deleteInspectorProject(companyId: string, id: string): Promise<boolean> {
  const project = getInspectorProject(companyId, id);
  if (!project) return false;
  projects.delete(id);
  for (const child of running.get(id) ?? []) child.kill("SIGTERM");
  running.delete(id);
  await fs.rm(project.dir, { recursive: true, force: true }).catch((error) =>
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "inspector project cleanup failed"),
  );
  return true;
}

const TEXT_EXTENSIONS = new Set([
  ".smali", ".xml", ".java", ".kt", ".json", ".yml", ".yaml", ".txt", ".properties", ".html", ".htm", ".js", ".css", ".md", ".cfg", ".pro",
]);
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_ENTRIES = 60_000;
const SEARCH_MAX_TEXT_FILE = 512 * 1024;
const SEARCH_DEADLINE_MS = 8_000;

export interface InspectorSearchHit {
  path: string;
  dir: boolean;
  /** 1-based line of a text match; null for a name match. */
  line: number | null;
  preview: string | null;
}

/**
 * Find files by name, or text inside them, across one view of a project. Bounded
 * (results, files walked, file size and time) so a huge app can't stall the server.
 */
export async function searchInspector(
  companyId: string,
  id: string,
  view: InspectorView,
  query: string,
  mode: "name" | "text",
): Promise<{ results: InspectorSearchHit[]; truncated: boolean }> {
  const project = readyProject(companyId, id, view);
  const root = viewRoot(project, view);
  const needle = query.trim().toLowerCase();
  if (needle.length < (mode === "text" ? 2 : 1)) return { results: [], truncated: false };
  const deadline = Date.now() + SEARCH_DEADLINE_MS;
  const results: InspectorSearchHit[] = [];
  const stack = [""];
  let visited = 0;
  let truncated = false;
  while (stack.length > 0) {
    if (results.length >= SEARCH_MAX_RESULTS || visited >= SEARCH_MAX_ENTRIES || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const relative = stack.pop()!;
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      visited += 1;
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!(relative === "" && entry.name === "build")) stack.push(entryPath);
        if (mode === "name" && entry.name.toLowerCase().includes(needle)) results.push({ path: entryPath, dir: true, line: null, preview: null });
        continue;
      }
      if (!entry.isFile()) continue;
      if (mode === "name") {
        if (entry.name.toLowerCase().includes(needle)) results.push({ path: entryPath, dir: false, line: null, preview: null });
      } else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const file = path.join(root, entryPath);
        const size = await fs.stat(file).then((stat) => stat.size, () => Infinity);
        if (size > SEARCH_MAX_TEXT_FILE) continue;
        const text = await fs.readFile(file, "utf8").catch(() => "");
        if (!text.toLowerCase().includes(needle)) continue;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < SEARCH_MAX_RESULTS; index += 1) {
          if (lines[index]!.toLowerCase().includes(needle)) {
            results.push({ path: entryPath, dir: false, line: index + 1, preview: lines[index]!.trim().slice(0, 160) });
            break;
          }
        }
      }
      if (results.length >= SEARCH_MAX_RESULTS) break;
    }
  }
  results.sort((a, b) => a.path.localeCompare(b.path));
  return { results, truncated };
}

/** An image inside a project, for a thumbnail or preview. Only plain image types. */
export async function inspectorImageFile(companyId: string, id: string, view: InspectorView, relative: string): Promise<{ file: string; type: string }> {
  const project = readyProject(companyId, id, view);
  const file = resolveInView(project, view, relative);
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error("That isn't an image Automa can show.");
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("That is a folder");
  return { file, type };
}

export interface InspectorAppInfo {
  packageName: string | null;
  label: string | null;
  versionName: string | null;
  versionCode: string | null;
  minSdk: string | null;
  targetSdk: string | null;
  /** The launcher icon as a project path (a bitmap), when the app has one. */
  iconPath: string | null;
  launcherActivity: string | null;
  debuggable: boolean;
  permissions: string[];
  activities: string[];
  services: string[];
  receivers: string[];
  providers: string[];
}

const DENSITIES = ["xxxhdpi", "xxhdpi", "xhdpi", "hdpi", "mdpi", ""];

function attribute(tag: string, name: string): string | null {
  return new RegExp(`android:${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

function tagsOf(manifest: string, tag: string): string[] {
  return [...manifest.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))].map((match) => match[0]);
}

/** What the app is, read from its decoded manifest and apktool.yml. */
export async function inspectorAppInfo(companyId: string, id: string): Promise<InspectorAppInfo> {
  const project = readyProject(companyId, id, "files");
  const root = decodedDir(project);
  const manifest = await fs.readFile(path.join(root, "AndroidManifest.xml"), "utf8").catch(() => "");
  const yml = await fs.readFile(path.join(root, "apktool.yml"), "utf8").catch(() => "");
  const yamlValue = (key: string) => new RegExp(`${key}:\\s*'?"?([^'"\\n]+)`).exec(yml)?.[1]?.trim() ?? null;
  const application = tagsOf(manifest, "application")[0] ?? "";
  const names = (tag: string) => tagsOf(manifest, tag).map((t) => attribute(t, "name")).filter((n): n is string => Boolean(n));

  let label = attribute(application, "label");
  const stringRef = label?.match(/^@string\/(.+)$/);
  if (stringRef) {
    const strings = await fs.readFile(path.join(root, "res", "values", "strings.xml"), "utf8").catch(() => "");
    label = new RegExp(`<string name="${stringRef[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]*)</string>`).exec(strings)?.[1] ?? null;
  }

  let iconPath: string | null = null;
  const iconRef = (attribute(application, "icon") ?? "").match(/^@(mipmap|drawable)\/(.+)$/);
  if (iconRef) {
    outer: for (const density of DENSITIES) {
      for (const kind of [iconRef[1], iconRef[1] === "mipmap" ? "drawable" : "mipmap"]) {
        const folder = density ? `${kind}-${density}` : kind;
        for (const ext of [".png", ".webp", ".jpg"]) {
          const candidate = `res/${folder}/${iconRef[2]}${ext}`;
          if (existsSync(path.join(root, candidate))) {
            iconPath = candidate;
            break outer;
          }
        }
      }
    }
  }

  // The activity whose intent filter has the LAUNCHER category.
  let launcherActivity: string | null = null;
  for (const block of manifest.matchAll(/<activity(?:-alias)?\b([^>]*)>([\s\S]*?)<\/activity(?:-alias)?>/g)) {
    if (block[2]!.includes("android.intent.category.LAUNCHER")) {
      launcherActivity = attribute(block[1]!, "name");
      break;
    }
  }

  return {
    packageName: /<manifest\b[^>]*\bpackage="([^"]+)"/.exec(manifest)?.[1] ?? project.packageName,
    label,
    versionName: yamlValue("versionName"),
    versionCode: yamlValue("versionCode"),
    minSdk: yamlValue("minSdkVersion"),
    targetSdk: yamlValue("targetSdkVersion"),
    iconPath,
    launcherActivity,
    debuggable: attribute(application, "debuggable") === "true",
    permissions: [...new Set(names("uses-permission"))].sort(),
    activities: names("activity"),
    services: names("service"),
    receivers: names("receiver"),
    providers: names("provider"),
  };
}

/** A message for the person, without the server's own paths in it. */
export function inspectorErrorMessage(error: unknown, fallback: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "That file or folder isn't there.";
  if (code === "EACCES" || code === "EPERM") return "Automa isn't allowed to open that.";
  if (code === "ENOTDIR") return "That is a file, not a folder.";
  if (code === "EISDIR") return "That is a folder";
  return error instanceof Error && !code ? error.message : fallback;
}

/** Test-only. */
export function __resetInspector(): void {
  projects.clear();
  running.clear();
  loaded = false;
}

const run = promisify(exec);

function onPhone(): boolean {
  return process.platform === "android" || (process.env.PREFIX ?? "").includes("com.termux");
}

async function hasCommand(name: string): Promise<boolean> {
  try {
    await run(`command -v ${name}`, { shell: process.env.SHELL || "/bin/sh", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function inspectorStatus(): Promise<{ kind: "phone" | "computer"; apktoolReady: boolean; jadxReady: boolean }> {
  const [apktoolReady, jadxReady] = await Promise.all([hasCommand("apktool"), hasCommand("jadx")]);
  return { kind: onPhone() ? "phone" : "computer", apktoolReady, jadxReady };
}

/**
 * The user-installed apps on this phone (package names), for a browser that
 * isn't the Automa app (which lists them itself, with names and icons). Empty
 * off-phone, or when Android won't answer `pm` from Termux.
 */
export async function listInstalledApps(): Promise<string[]> {
  if (!onPhone()) return [];
  try {
    const { stdout } = await run("pm list packages -3", { timeout: 15000 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/^package:/, "").trim())
      .filter((name) => /^[A-Za-z0-9_.]+$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** The base APK path of an installed package, and how many split APKs it has. */
export async function resolveInstalledApkPath(pkg: string): Promise<{ apkPath: string; splitCount: number }> {
  if (!/^[A-Za-z0-9_.]+$/.test(pkg)) throw new Error("That is not a package name.");
  const { stdout } = await run(`pm path ${pkg}`, { timeout: 10000 }).catch(() => ({ stdout: "" }));
  const paths = stdout.split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).filter((l) => l.endsWith(".apk"));
  const base = paths.find((l) => l.endsWith("/base.apk")) ?? paths[0];
  if (!base) throw new Error("Could not find that app's APK on this device.");
  return { apkPath: base, splitCount: paths.length - 1 };
}
