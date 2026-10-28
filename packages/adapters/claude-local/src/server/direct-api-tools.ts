import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { asString, buildPaperclipEnv, parseObject, sanitizeInheritedPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

/**
 * Tools for the direct API engine, so an agent that answers through the
 * Anthropic API (on a phone, or set to `engine: "api"`) can work the way
 * Claude Code does: read and change files, run commands, search, and use the
 * Automa API. The names and inputs match Claude Code's tools, so the chat
 * shows them the same way it shows a desktop agent's.
 *
 * Commands run in the server's own shell. On a phone that is Termux, where
 * `termux-*` commands (Termux:API) reach the device and ~/storage/shared is
 * the phone's storage once `termux-setup-storage` has run. These agents have
 * the same reach as a Claude Code agent with permissions skipped (the
 * default for agents here), which is why file paths are not confined.
 */

const MAX_READ_LINES = 2_000;
const MAX_TOOL_OUTPUT_CHARS = 30_000;
const MAX_LINE_CHARS = 2_000;
const DEFAULT_COMMAND_TIMEOUT_SEC = 120;
const MAX_COMMAND_TIMEOUT_SEC = 600;
const MAX_SEARCH_RESULTS = 200;
const MAX_GLOB_RESULTS = 300;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
/** Folders a search never walks into: generated, vendored, or version control. */
const SKIPPED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", ".cache", "coverage", "__pycache__", ".venv"]);

export const DIRECT_TOOL_NAMES = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Automa"] as const;
export type DirectToolName = (typeof DIRECT_TOOL_NAMES)[number];

/** True when `config.tools` turns tools off ("none", "off", false). */
export function directApiToolsDisabled(config: Record<string, unknown>): boolean {
  const value = config.directApiTools ?? config.tools;
  if (value === false) return true;
  return typeof value === "string" && ["none", "off", "false", "text"].includes(value.trim().toLowerCase());
}

/**
 * The tool definitions sent with each request. Large inputs (a whole file)
 * stream as they are written when `eagerInput` is on; that is only safe
 * against Anthropic's own API, so a custom base URL leaves it off.
 */
export function directApiToolDefinitions(options: { eagerInput: boolean }): Anthropic.Tool[] {
  const eager = options.eagerInput ? { eager_input_streaming: true as const } : {};
  return [
    {
      name: "Read",
      description:
        "Read a text file. Returns numbered lines. Use offset and limit (in lines) for long files. Relative paths are inside the working folder.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path of the file to read" },
          offset: { type: "integer", description: "First line to read, starting at 1" },
          limit: { type: "integer", description: `How many lines to read (at most ${MAX_READ_LINES})` },
        },
        required: ["file_path"],
      },
    },
    {
      name: "Write",
      description: "Create a file or replace its whole contents. Folders are created as needed. Read a file before replacing it.",
      ...eager,
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path of the file to write" },
          content: { type: "string", description: "The complete new contents" },
        },
        required: ["file_path", "content"],
      },
    },
    {
      name: "Edit",
      description:
        "Replace exact text in a file. old_string must appear exactly once unless replace_all is true; include enough surrounding lines to make it unique.",
      ...eager,
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path of the file to change" },
          old_string: { type: "string", description: "Exact text to replace" },
          new_string: { type: "string", description: "Text to put in its place" },
          replace_all: { type: "boolean", description: "Replace every occurrence" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
    {
      name: "Bash",
      description:
        `Run a shell command in the working folder and get its output and exit code. Times out after ${DEFAULT_COMMAND_TIMEOUT_SEC} seconds unless timeout is set (at most ${MAX_COMMAND_TIMEOUT_SEC}). Nothing runs in the background after it returns.`,
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
          description: { type: "string", description: "A few words on what it does, shown to the person" },
          timeout: { type: "integer", description: "Seconds before the command is stopped" },
        },
        required: ["command"],
      },
    },
    {
      name: "Grep",
      description: "Search file contents with a regular expression. Returns path:line: text for each match.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression" },
          path: { type: "string", description: "File or folder to search (default: the working folder)" },
          glob: { type: "string", description: "Only files whose path matches this glob, e.g. **/*.ts" },
          case_insensitive: { type: "boolean" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "Glob",
      description: "List files whose path matches a glob pattern such as **/*.md or src/*.ts, newest first.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Folder to search (default: the working folder)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "Automa",
      description:
        "Call the Automa API as this agent (tasks, comments, agents, projects). path starts with /api/, for example GET /api/agents/me or POST /api/companies/{companyId}/issues.",
      input_schema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
          path: { type: "string", description: "Path starting with /api/" },
          body: { type: "object", description: "JSON body for POST, PATCH and PUT" },
        },
        required: ["method", "path"],
      },
    },
  ];
}

const SERVER_ONLY_ENV_KEYS = new Set(["DATABASE_URL", "BETTER_AUTH_SECRET"]);

export interface DirectToolRuntime {
  cwd: string;
  env: Record<string, string>;
  apiUrl: string;
  authToken: string | null;
  signal?: AbortSignal;
}

/** The working folder and environment a tool runs with, as a Claude Code run would get them. */
export function directToolRuntime(ctx: AdapterExecutionContext): DirectToolRuntime {
  const workspace = parseObject(ctx.context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "");
  const configuredCwd = asString(ctx.config.cwd, "");
  const useConfigured = asString(workspace.source, "") === "agent_home" && configuredCwd.length > 0;
  const cwd = (useConfigured ? "" : workspaceCwd) || configuredCwd || process.cwd();
  const paperclipEnv = buildPaperclipEnv(ctx.agent);
  const env: Record<string, string> = {};
  // Like a Claude Code run, commands never inherit the server's own app key,
  // database password or sign-in secret.
  for (const [key, value] of Object.entries(sanitizeInheritedPaperclipEnv(process.env))) {
    if (typeof value === "string" && !SERVER_ONLY_ENV_KEYS.has(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(parseObject(ctx.config.env))) {
    // The run token is the only PAPERCLIP_API_KEY, and the runtime's own
    // PAPERCLIP_* values win, as for a Claude Code run.
    if (typeof value === "string" && !key.startsWith("PAPERCLIP_")) env[key] = value;
  }
  Object.assign(env, paperclipEnv, { PAPERCLIP_RUN_ID: ctx.runId });
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
  return { cwd, env, apiUrl: paperclipEnv.PAPERCLIP_API_URL ?? "", authToken: ctx.authToken ?? null, signal: ctx.signal };
}

export interface DirectToolOutcome {
  content: string;
  isError: boolean;
}

function fail(message: string): DirectToolOutcome {
  return { content: message, isError: true };
}

/** Long output keeps its beginning and end, which is where errors and results usually are. */
export function clipOutput(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… ${text.length - max} characters left out …\n\n${text.slice(-half)}`;
}

function resolvePath(runtime: DirectToolRuntime, raw: string): string {
  const expanded = raw.startsWith("~/") ? path.join(runtime.env.HOME ?? process.env.HOME ?? "", raw.slice(2)) : raw;
  return path.resolve(runtime.cwd, expanded);
}

function str(input: Record<string, unknown>, key: string): string | null {
  return typeof input[key] === "string" ? (input[key] as string) : null;
}

function int(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8_000).includes(0);
}

async function readTool(runtime: DirectToolRuntime, input: Record<string, unknown>): Promise<DirectToolOutcome> {
  const raw = str(input, "file_path");
  if (!raw) return fail("file_path is required.");
  const file = resolvePath(runtime, raw);
  let bytes: Buffer;
  try {
    const stat = await fs.stat(file);
    if (stat.isDirectory()) return fail(`${file} is a folder. Use Glob or Bash (ls) to list it.`);
    bytes = await fs.readFile(file);
  } catch (error) {
    return fail(`Could not read ${file}: ${(error as Error).message}`);
  }
  if (looksBinary(bytes)) return { content: `${file} is a binary file (${bytes.length} bytes).`, isError: false };
  const lines = bytes.toString("utf8").split("\n");
  const offset = Math.max(1, int(input, "offset") ?? 1);
  const limit = Math.min(MAX_READ_LINES, Math.max(1, int(input, "limit") ?? MAX_READ_LINES));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice
    .map((line, index) => `${String(offset + index).padStart(6)}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`)
    .join("\n");
  const rest = lines.length - (offset - 1 + slice.length);
  const note = rest > 0 ? `\n\n(${rest} more lines; read on with offset ${offset + slice.length}.)` : "";
  return { content: clipOutput(`${numbered}${note}`), isError: false };
}

async function writeTool(runtime: DirectToolRuntime, input: Record<string, unknown>): Promise<DirectToolOutcome> {
  const raw = str(input, "file_path");
  const content = str(input, "content");
  if (!raw || content === null) return fail("file_path and content are required.");
  const file = resolvePath(runtime, raw);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  } catch (error) {
    return fail(`Could not write ${file}: ${(error as Error).message}`);
  }
  return { content: `Wrote ${content.split("\n").length} lines to ${file}.`, isError: false };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

async function editTool(runtime: DirectToolRuntime, input: Record<string, unknown>): Promise<DirectToolOutcome> {
  const raw = str(input, "file_path");
  const oldString = str(input, "old_string");
  const newString = str(input, "new_string");
  if (!raw || oldString === null || newString === null) return fail("file_path, old_string and new_string are required.");
  if (!oldString) return fail("old_string is empty. Use Write to create a file.");
  if (oldString === newString) return fail("old_string and new_string are the same.");
  const file = resolvePath(runtime, raw);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    return fail(`Could not read ${file}: ${(error as Error).message}`);
  }
  const count = countOccurrences(text, oldString);
  if (count === 0) return fail(`old_string was not found in ${file}. Read the file and copy the text exactly.`);
  const replaceAll = input.replace_all === true;
  if (count > 1 && !replaceAll) {
    return fail(`old_string appears ${count} times in ${file}. Add surrounding lines to make it unique, or set replace_all.`);
  }
  const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
  try {
    await fs.writeFile(file, next, "utf8");
  } catch (error) {
    return fail(`Could not write ${file}: ${(error as Error).message}`);
  }
  return { content: `Edited ${file} (${replaceAll ? count : 1} replacement${replaceAll && count > 1 ? "s" : ""}).`, isError: false };
}

/** The shell commands run in: Termux's bash on a phone, else the user's shell. */
function shellPath(env: Record<string, string>): string {
  if (process.platform === "android" && env.PREFIX) return path.join(env.PREFIX, "bin", "bash");
  return env.SHELL || "/bin/sh";
}

async function bashTool(runtime: DirectToolRuntime, input: Record<string, unknown>): Promise<DirectToolOutcome> {
  const command = str(input, "command");
  if (!command?.trim()) return fail("command is required.");
  const timeoutSec = Math.min(MAX_COMMAND_TIMEOUT_SEC, Math.max(1, int(input, "timeout") ?? DEFAULT_COMMAND_TIMEOUT_SEC));
  await fs.mkdir(runtime.cwd, { recursive: true }).catch(() => undefined);
  return await new Promise<DirectToolOutcome>((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(shellPath(runtime.env), ["-c", command], {
      cwd: runtime.cwd,
      env: runtime.env,
      // Its own process group, so Stop and timeouts end everything it started.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk: Buffer) => {
      // Only the tail is kept once it gets long; clipOutput trims the rest.
      output += chunk.toString("utf8");
      if (output.length > MAX_TOOL_OUTPUT_CHARS * 4) output = output.slice(-MAX_TOOL_OUTPUT_CHARS * 2);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSec * 1_000);
    const onAbort = () => kill();
    runtime.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (outcome: DirectToolOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runtime.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    child.on("error", (error) => finish(fail(`Could not run the command: ${error.message}`)));
    child.on("close", (code, signal) => {
      const body = clipOutput(output.trimEnd()) || "(no output)";
      if (timedOut) return finish(fail(`Stopped after ${timeoutSec} seconds.\n${body}`));
      if (runtime.signal?.aborted) return finish(fail(`Stopped.\n${body}`));
      finish({ content: `Exit code ${code ?? signal ?? "unknown"}\n${body}`, isError: code !== 0 });
    });
  });
}

/** A glob as a regular expression over forward-slash paths: **, * and ?. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

async function* walk(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stack = [root];
  while (stack.length > 0) {
    if (signal?.aborted) return;
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

function relativeSlashPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

async function grepTool(runtime: DirectToolRuntime, input: Record<string, unknown>): Promise<DirectToolOutcome> {
  const pattern = str(input, "pattern");
  if (!pattern) return fail("pattern is required.");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, input.case_insensitive === true ? "i" : "");
  } catch (error) {
    return fail(`That is not a valid regular expression: ${(error as Error).message}`);
  }
  const target = resolvePath(runtime, str(input, "path") ?? ".");
  const glob = str(input, "glob");
  const globRegex = glob ? globToRegExp(glob) : null;
  const matches: string[] = [];
  let files: AsyncIterable<string> | string[];
  try {
    files = (await fs.stat(target)).isFile() ? [target] : walk(target, runtime.signal);
  } catch (error) {
    return fail(`Could not search ${target}: ${(error as Error).message}`);
  }
  outer: for await (const file of files) {
    const relative = relativeSlashPath(runtime.cwd, file);
    if (globRegex && !globRegex.test(relative) && !globRegex.test(path.basename(file))) continue;
    let bytes: Buffer;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
      bytes = await fs.readFile(file);
    } catch {
      continue;
    }
    if (looksBinary(bytes)) continue;
    const lines = bytes.toString("utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index]!)) continue;
      matches.push(`${relative}:${index + 1}: ${lines[index]!.slice(0, 300)}`);
      if (matches.length >= MAX_SEARCH_RESULTS) break outer;
    }
  }
  if (matches.length === 0) return { content: "No matches.", isError: false };
  const more = matches.length >= MAX_SEARCH_RESULTS ? `\n(Stopped at ${MAX_SEARCH_RESULTS} matches; narrow the search.)` : "";
  return { content: clipOutput(matches.join("\n") + more), isError: false };
}

async function globTool(runtime: DirectToolRuntime, input: Record<string, unknown>): Promise<DirectToolOutcome> {
  const pattern = str(input, "pattern");
  if (!pattern) return fail("pattern is required.");
  const root = resolvePath(runtime, str(input, "path") ?? ".");
  const regex = globToRegExp(pattern);
  const found: Array<{ file: string; mtime: number }> = [];
  for await (const file of walk(root, runtime.signal)) {
    const relative = relativeSlashPath(root, file);
    if (!regex.test(relative)) continue;
    const mtime = await fs.stat(file).then((stat) => stat.mtimeMs, () => 0);
    found.push({ file: relative, mtime });
    if (found.length >= MAX_GLOB_RESULTS * 4) break;
  }
  if (found.length === 0) return { content: "No files match.", isError: false };
  found.sort((a, b) => b.mtime - a.mtime);
  const shown = found.slice(0, MAX_GLOB_RESULTS).map((item) => item.file);
  const more = found.length > MAX_GLOB_RESULTS ? `\n(${found.length - MAX_GLOB_RESULTS} more; narrow the pattern.)` : "";
  return { content: shown.join("\n") + more, isError: false };
}

async function automaTool(runtime: DirectToolRuntime, input: Record<string, unknown>): Promise<DirectToolOutcome> {
  const method = (str(input, "method") ?? "GET").toUpperCase();
  const apiPath = str(input, "path");
  if (!apiPath || !apiPath.startsWith("/api/")) return fail("path must start with /api/.");
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) return fail(`Unsupported method ${method}.`);
  if (!runtime.authToken || !runtime.apiUrl) return fail("This run has no Automa API access.");
  const body = input.body && typeof input.body === "object" ? JSON.stringify(input.body) : undefined;
  try {
    const response = await fetch(`${runtime.apiUrl}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${runtime.authToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
        "x-paperclip-run-id": runtime.env.PAPERCLIP_RUN_ID ?? "",
      },
      body: method === "GET" || method === "DELETE" ? undefined : body,
      signal: runtime.signal,
    });
    const text = await response.text();
    return { content: clipOutput(`HTTP ${response.status}\n${text}`), isError: !response.ok };
  } catch (error) {
    return fail(`The Automa API could not be reached: ${(error as Error).message}`);
  }
}

/** Runs one tool call. Unknown tools and bad input come back as errors the model can read. */
export async function runDirectTool(
  runtime: DirectToolRuntime,
  name: string,
  input: unknown,
): Promise<DirectToolOutcome> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    // A tool input the model cut off or garbled is handed back so it can try again.
    return fail(JSON.stringify({ INVALID_JSON: JSON.stringify(input ?? null) }));
  }
  const record = input as Record<string, unknown>;
  switch (name) {
    case "Read": return readTool(runtime, record);
    case "Write": return writeTool(runtime, record);
    case "Edit": return editTool(runtime, record);
    case "Bash": return bashTool(runtime, record);
    case "Grep": return grepTool(runtime, record);
    case "Glob": return globTool(runtime, record);
    case "Automa": return automaTool(runtime, record);
    default: return fail(`There is no tool named ${name}.`);
  }
}

/** A tool call as the chat shows it: big inputs (a whole file) are cut to a preview. */
export function toolInputForLog(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = typeof value === "string" && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  }
  return out;
}
