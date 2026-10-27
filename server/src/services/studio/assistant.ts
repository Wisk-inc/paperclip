import { conflict } from "../../errors.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  STUDIO_ASSISTANT_IMAGE_TYPES,
  STUDIO_AI_PROVIDER_INFO,
  studioLanguage,
  studioThinkingLevels,
  type StudioAiProvider,
  type StudioAssistantAttachmentInput,
  type StudioAssistantStep,
  type StudioAssistantTurn,
  type StudioThinkingLevel,
} from "@paperclipai/shared";
import { claudeBilledSpend, estimateApiCostUsd, type ClaudeApiUsage } from "@paperclipai/shared";
import {
  describePuterError,
  isTransientPuterError,
  puterComplete,
  puterStream,
  PuterHttpError,
  type PuterMessage,
  type PuterTool,
  type PuterToolCall,
  type PuterUsage,
} from "@paperclipai/shared/puter-ai";
import { createThinkingTagSplitter, readThinkingLevel, thinkingInstruction } from "../../adapters/free-models/thinking.js";
import { modelLabel, toolHistoryAsText } from "../../adapters/free-models/execute.js";
import { logger } from "../../middleware/logger.js";
import {
  deleteStudioEntry,
  listFilePaths,
  readStudioFile,
  resolveInside,
  studioWorkspaceDirs,
  writeStudioFile,
} from "./files.js";
import { studioHub } from "./hub.js";
import { studioRuntime } from "./runner.js";

/** Tokens one model call used, for Costs. */
export interface StudioAiUsage {
  provider: StudioAiProvider;
  model: string;
  /** Uncached input tokens (including prompt-cache writes). */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Provider-reported or list-price cost; null when unknown. */
  costUsd: number | null;
}

/** What the assistant needs about the project it works in. */
export interface StudioAssistantContext {
  workspaceId: string;
  companyId: string;
  name: string;
  language: string;
  runCommand: string;
  /** Starts the app the same way the Run button does. */
  startApp: () => Promise<void>;
  /** Tells everyone a file changed. */
  onFileChanged: (relativePath: string) => Promise<void>;
  /** Records what each model call used (Costs counts App Studio too). */
  onUsage?: (usage: StudioAiUsage) => Promise<void> | void;
  /** Other models the lead can hand tasks to this turn (set per turn, never nested). */
  team?: TeamRuntime;
}

/** A model that works for the lead: its provider, name, and the key that pays for it. */
export interface StudioTeamMember {
  provider: StudioAiProvider;
  model: string;
  credentials: ProviderCredentials;
}

interface TeamRuntime {
  members: StudioTeamMember[];
  /** Runs one task on a teammate and returns its written report. */
  delegate: (member: StudioTeamMember, task: string, signal: AbortSignal) => Promise<string>;
}

/** A teammate as the lead names it: by model id, a number, or a word of the name. */
function pickTeammate(members: StudioTeamMember[], who: string): StudioTeamMember | undefined {
  const wanted = who.trim().toLowerCase();
  if (!wanted) return members[0];
  const index = Number(wanted);
  if (Number.isInteger(index) && index >= 1 && index <= members.length) return members[index - 1];
  return members.find((m) => m.model.toLowerCase() === wanted)
    ?? members.find((m) => m.model.toLowerCase().includes(wanted) || modelLabel(m.model).toLowerCase().includes(wanted) || m.provider === wanted);
}

function askTeammateTool(members: StudioTeamMember[]) {
  const list = members.map((m, i) => `${i + 1}. ${modelLabel(m.model)} (${m.provider}; id "${m.model}")`).join("; ");
  return {
    name: "ask_teammate",
    description: `Hand a self-contained task to a teammate model and get its written report. Teammates: ${list}. They have the same file, command and app tools as you, see the project as it is now, and report what they changed with file paths. Give one clear task with everything needed (which files, what behaviour, how to test); split work across teammates for different parts; review their changes afterwards.`,
    schema: z.object({ teammate: z.string().min(1), task: z.string().min(1).max(20_000) }),
    parameters: {
      type: "object",
      properties: {
        teammate: { type: "string", description: "The teammate's number, model id, or a word from its name" },
        task: { type: "string", description: "The whole task, self-contained" },
      },
      required: ["teammate", "task"],
      additionalProperties: false,
    },
  };
}

/** The tools this turn offers: the project tools, plus ask_teammate when the lead has a team. */
function toolsFor(context: StudioAssistantContext) {
  return context.team?.members.length ? [...TOOLS, askTeammateTool(context.team.members)] : TOOLS;
}

const MAX_STEPS = 30;
const MAX_TOOL_OUTPUT = 40_000;
const MAX_HISTORY_CHARS = 900_000;

// ── Tools ─────────────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  parameters: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "list_files",
    description: "List the project's files and folders (dependency folders such as node_modules are skipped).",
    schema: z.object({}).passthrough(),
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a text file in the project. Paths are relative to the project folder.",
    schema: z.object({ path: z.string().min(1) }),
    parameters: { type: "object", properties: { path: { type: "string", description: "Path inside the project, e.g. src/app.js" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "write_file",
    description: "Create or replace a file with the full contents given. Creates folders as needed.",
    schema: z.object({ path: z.string().min(1), content: z.string() }),
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string", description: "The complete new contents of the file" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact snippet in a file. old_text must appear exactly once; include enough surrounding lines to make it unique.",
    schema: z.object({ path: z.string().min(1), old_text: z.string().min(1), new_text: z.string() }),
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_path",
    description: "Delete a file or folder in the project.",
    schema: z.object({ path: z.string().min(1) }),
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the project folder and get its output (stdout and stderr) and exit code. Use it for builds, tests, installing packages, and one-off programs. Do not start long-running servers here; use start_app.",
    schema: z.object({ command: z.string().min(1), timeout_seconds: z.number().int().min(1).max(600).optional() }),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 600, description: "Defaults to 120" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "read_console",
    description: "Read the latest lines of the project's console (output of the running app and of earlier commands).",
    schema: z.object({ lines: z.number().int().min(1).max(1000).optional() }),
    parameters: { type: "object", properties: { lines: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false },
  },
  {
    name: "start_app",
    description: "Run the project with its run command (restarting it if it is running), wait a few seconds, and return its status and console output. The app gets its port in $PORT.",
    schema: z.object({}).passthrough(),
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stop_app",
    description: "Stop the running app.",
    schema: z.object({}).passthrough(),
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

function clip(text: string, max = MAX_TOOL_OUTPUT) {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters cut off)` : text;
}

/** What a tool call is about to do, said the way the panel says it. */
export function describeActivity(name: string, rawInput: unknown): string {
  const input = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  const text = (value: unknown, max = 80) => {
    const one = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  };
  const target = text(input.path);
  switch (name) {
    case "list_files":
      return "Looking through the files";
    case "read_file":
      return target ? `Reading ${target}` : "Reading a file";
    case "write_file":
      return target ? `Writing ${target}` : "Writing a file";
    case "edit_file":
      return target ? `Editing ${target}` : "Editing a file";
    case "delete_path":
      return target ? `Deleting ${target}` : "Deleting a file";
    case "run_command": {
      const command = text(input.command);
      return command ? `Running ${command}` : "Running a command";
    }
    case "read_console":
      return "Reading the console";
    case "start_app":
      return "Starting the app";
    case "stop_app":
      return "Stopping the app";
    case "ask_teammate": {
      const who = text(input.teammate, 40);
      return who ? `Asking ${who}` : "Asking a teammate";
    }
    default:
      return "Working";
  }
}

interface ToolOutcome {
  ok: boolean;
  output: string;
  step: StudioAssistantStep;
}

async function runTool(context: StudioAssistantContext, name: string, rawInput: unknown, signal?: AbortSignal): Promise<ToolOutcome> {
  const def = toolsFor(context).find((tool) => tool.name === name);
  if (!def) return { ok: false, output: `Unknown tool ${name}`, step: { tool: name, summary: name, ok: false, detail: "Unknown tool" } };
  const parsed = def.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const message = `Invalid input for ${name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
    return { ok: false, output: message, step: { tool: name, summary: name, ok: false, detail: message } };
  }
  const input = parsed.data as Record<string, unknown>;
  if (name === "ask_teammate") {
    const members = context.team?.members ?? [];
    const member = pickTeammate(members, String(input.teammate ?? ""));
    if (!member || !context.team) {
      const message = `No such teammate. Teammates: ${members.map((m, i) => `${i + 1}. ${m.model}`).join("; ") || "(none)"}`;
      return { ok: false, output: message, step: { tool: name, summary: "ask_teammate", ok: false, detail: message } };
    }
    const task = String(input.task ?? "");
    const who = modelLabel(member.model);
    try {
      const report = await context.team.delegate(member, task, signal ?? new AbortController().signal);
      return { ok: true, output: `${who} reports:\n\n${clip(report, 12_000)}`, step: { tool: name, summary: `${who} reported back`, ok: true, detail: clip(report, 4000) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: `${who} could not finish: ${message}`, step: { tool: name, summary: `${who} could not finish`, ok: false, detail: message } };
    }
  }
  const dirs = studioWorkspaceDirs(context.companyId, context.workspaceId);
  const runtime = studioRuntime(context.workspaceId);
  try {
    switch (name) {
      case "list_files": {
        const files = await listFilePaths(dirs.files, 1000);
        return { ok: true, output: files.join("\n") || "(the project is empty)", step: { tool: name, summary: `Listed ${files.length} files`, ok: true, detail: null } };
      }
      case "read_file": {
        const file = await readStudioFile(dirs.files, String(input.path));
        const output = file.content === null ? `(${file.binary ? "binary" : "too large"} file, ${file.size} bytes)` : clip(file.content);
        return { ok: true, output, step: { tool: name, summary: `Read ${file.path}`, ok: true, detail: null } };
      }
      case "write_file": {
        const written = await writeStudioFile(dirs.files, String(input.path), String(input.content));
        await context.onFileChanged(written.path);
        return { ok: true, output: `Wrote ${written.path} (${written.size} bytes).`, step: { tool: name, summary: `Wrote ${written.path}`, ok: true, detail: null } };
      }
      case "edit_file": {
        const file = await readStudioFile(dirs.files, String(input.path));
        if (file.content === null) throw new Error("That file is not text");
        const oldText = String(input.old_text);
        const count = file.content.split(oldText).length - 1;
        if (count === 0) throw new Error("old_text was not found in the file; read the file and try again with an exact snippet");
        if (count > 1) throw new Error(`old_text appears ${count} times; include more surrounding lines so it is unique`);
        const written = await writeStudioFile(dirs.files, file.path, file.content.replace(oldText, () => String(input.new_text)));
        await context.onFileChanged(written.path);
        return { ok: true, output: `Edited ${written.path}.`, step: { tool: name, summary: `Edited ${written.path}`, ok: true, detail: null } };
      }
      case "delete_path": {
        await deleteStudioEntry(dirs.files, String(input.path));
        await context.onFileChanged(String(input.path));
        return { ok: true, output: `Deleted ${input.path}.`, step: { tool: name, summary: `Deleted ${input.path}`, ok: true, detail: null } };
      }
      case "run_command": {
        const command = String(input.command);
        const timeoutMs = (Number(input.timeout_seconds) || 120) * 1000;
        const result = await runtime.exec(dirs.files, command, { timeoutMs, signal });
        const output = `${result.timedOut ? "(stopped: took too long)\n" : ""}exit code: ${result.exitCode}\n${clip(result.output)}`;
        return {
          ok: result.exitCode === 0 && !result.timedOut,
          output,
          step: { tool: name, summary: `$ ${command}`, ok: result.exitCode === 0 && !result.timedOut, detail: clip(result.output, 1200) || null },
        };
      }
      case "read_console": {
        const tail = runtime.consoleTail(Number(input.lines) || 200);
        return { ok: true, output: tail || "(the console is empty)", step: { tool: name, summary: "Read the console", ok: true, detail: null } };
      }
      case "start_app": {
        await context.startApp();
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const state = runtime.state;
        const output = `status: ${state.status}${state.exitCode !== null ? ` (exit code ${state.exitCode})` : ""}\nweb preview ready: ${state.previewReady ? `yes (port ${state.port})` : "no"}\nconsole:\n${runtime.consoleTail(80)}`;
        return { ok: state.status !== "failed", output, step: { tool: name, summary: "Started the app", ok: state.status !== "failed", detail: clip(runtime.consoleTail(20), 1200) || null } };
      }
      case "stop_app": {
        await runtime.stop();
        return { ok: true, output: "Stopped.", step: { tool: name, summary: "Stopped the app", ok: true, detail: null } };
      }
    }
    return { ok: false, output: "Unhandled tool", step: { tool: name, summary: name, ok: false, detail: null } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const summary = typeof input.path === "string" ? `${name} ${input.path}` : typeof input.command === "string" ? `$ ${input.command}` : name;
    return { ok: false, output: `Error: ${message}`, step: { tool: name, summary, ok: false, detail: message } };
  }
}

function systemPrompt(context: StudioAssistantContext) {
  const language = studioLanguage(context.language);
  return [
    `You are the coding assistant in Automa Studio, building and fixing the user's project "${context.name}" (${language?.name ?? context.language}).`,
    "Every tool works inside the project folder; paths are relative to it.",
    `The project's run command is: ${context.runCommand || "(a static website served by Automa)"}.`,
    "Web apps get their port in the PORT environment variable and must listen on 127.0.0.1:$PORT; Automa shows them in its preview and can give them a public link.",
    "How to work: look at the files before changing them; use edit_file for small changes and write_file for new or rewritten files; after changing code, run it (start_app for apps and servers, run_command for scripts and tests) and read the output to confirm it works, then fix what fails.",
    "When the user describes an app in plain words, build all of it: the UI, the logic, and storage (for Node.js, the built-in node:sqlite module needs no install; for Python, sqlite3).",
    "Keep replies short: say what you changed and how to use it. Never print secrets or API keys, and do not touch anything outside the project folder.",
    ...(context.team?.members.length
      ? [
          `You lead a team of models. Teammates: ${context.team.members.map((m, i) => `${i + 1}. ${modelLabel(m.model)}`).join("; ")}. Use ask_teammate to hand them self-contained tasks (one part of the app each, a review, a tricky bug) while you keep the overall plan; they report back in writing. Check their work before you tell the user it is done.`,
        ]
      : []),
  ].join("\n");
}

/** What a teammate is told on top of the project prompt. */
const TEAMMATE_SYSTEM = "You are a teammate model working for the lead on one task in this project. Do the task with the tools, test it where you can, and finish with a short written report: what you changed (file paths), what works, what is left or unclear. Do not ask questions; make reasonable choices and say which you made.";

/**
 * The conversation so far as plain user/assistant text, from the transcript
 * every provider shares. Used when the person switches providers mid-chat:
 * the new provider's own history is empty, and the model would otherwise
 * start from nothing.
 */
function historyFromTranscript(turns: StudioAssistantTurn[]): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const turn of turns) {
    const steps = turn.steps.filter((step) => step.tool !== "say" && step.tool !== "think").map((step) => `${step.tool} ${step.summary}`.trim());
    const text = turn.role === "assistant"
      ? [turn.text.trim(), steps.length ? `[Steps taken: ${steps.join("; ").slice(0, 1500)}]` : "", turn.error ? `[This reply failed: ${turn.error}]` : ""].filter(Boolean).join("\n\n")
      : turn.text.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) last.content = `${last.content}\n\n${text}`;
    else out.push({ role: turn.role, content: text });
  }
  // Providers want the first message from the user.
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

/** User messages in a provider history that are the person speaking (not tool results). */
function spokenUserTurns(messages: Array<{ role: string; content: unknown }>): number {
  return messages.filter((m) => m.role === "user" && (typeof m.content === "string" || (Array.isArray(m.content) && m.content.some((part) => (part as { type?: string }).type === "text" || (part as { type?: string }).type === "image" || (part as { type?: string }).type === "image_url")))).length;
}

async function projectOverview(context: StudioAssistantContext) {
  const dirs = studioWorkspaceDirs(context.companyId, context.workspaceId);
  const files = await listFilePaths(dirs.files, 200);
  const runtime = studioRuntime(context.workspaceId);
  return `Project files right now:\n${files.join("\n") || "(empty)"}\n\nApp status: ${runtime.state.status}${runtime.state.previewReady ? `, serving on port ${runtime.state.port}` : ""}.`;
}

// ── Conversation storage ───────────────────────────────────────────────────

function metaFile(context: StudioAssistantContext, name: string) {
  return path.join(studioWorkspaceDirs(context.companyId, context.workspaceId).meta, name);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value));
  await fs.rename(`${file}.tmp`, file);
}

export async function readAssistantTranscript(companyId: string, workspaceId: string): Promise<StudioAssistantTurn[]> {
  return readJson(path.join(studioWorkspaceDirs(companyId, workspaceId).meta, "assistant-transcript.json"), []);
}

export async function clearAssistantConversation(companyId: string, workspaceId: string) {
  const meta = studioWorkspaceDirs(companyId, workspaceId).meta;
  for (const file of await fs.readdir(meta).catch(() => [] as string[])) {
    if (file.startsWith("assistant-")) await fs.rm(path.join(meta, file), { force: true });
  }
}

// ── Running a turn ─────────────────────────────────────────────────────────

const running = new Map<string, AbortController>();
/**
 * The reply being written, so a page that reloads mid-turn still shows it:
 * the text and thinking streamed so far, not just the finished steps.
 */
const liveTurns = new Map<string, () => StudioAssistantTurn>();

export function currentAssistantTurn(workspaceId: string): StudioAssistantTurn | null {
  return liveTurns.get(workspaceId)?.() ?? null;
}

export function isAssistantRunning(workspaceId: string) {
  return running.has(workspaceId);
}

export function stopAssistant(workspaceId: string) {
  running.get(workspaceId)?.abort();
}

/** Claude models that take the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

/** Claude 4.6 and newer think adaptively; older models use a fixed budget. */
function supportsAdaptiveThinking(model: string) {
  return /^claude-/.test(model) && !/^claude-(?:3|haiku-4|sonnet-4-[05]|opus-4-[015])/.test(model);
}

function supportsEffort(model: string) {
  return !/^claude-(?:haiku-4|sonnet-4-5|opus-4-[01]|sonnet-4-0|3)/.test(model) && /^claude-/.test(model);
}

/** The picked thinking level, when this provider's model takes it. */
function thinkingLevelFor(provider: StudioAiProvider, model: string, level: StudioThinkingLevel | undefined) {
  return level && studioThinkingLevels(provider, model).includes(level) ? level : null;
}

interface ProviderCredentials {
  apiKey: string;
  baseUrl: string | null;
}

/**
 * Runs one user message through the assistant: the model reads and edits
 * files, runs commands, and checks the console until it is done (or hits the
 * step limit). Progress streams to everyone in the project.
 */
export async function runAssistantTurn(input: {
  context: StudioAssistantContext;
  message: string;
  provider: StudioAiProvider;
  model: string;
  credentials: ProviderCredentials;
  /** The checkpoint saved just before this turn, to undo it. */
  checkpointId?: string | null;
  /** Images the model looks at and text files inlined into the prompt. */
  attachments?: StudioAssistantAttachmentInput[];
  /** How long the model thinks; ignored where the model has no such setting. */
  thinking?: StudioThinkingLevel;
  /** Models the lead can delegate to this turn. */
  team?: StudioTeamMember[];
}) {
  const { context } = input;
  if (running.has(context.workspaceId)) throw conflict("The assistant is still working; wait or tap Stop");
  const controller = new AbortController();
  running.set(context.workspaceId, controller);
  try {
    return await startTurn(input, controller);
  } catch (error) {
    // Nothing started: the next message must not be refused as "still working".
    running.delete(context.workspaceId);
    liveTurns.delete(context.workspaceId);
    throw error;
  }
}

async function startTurn(
  input: Parameters<typeof runAssistantTurn>[0],
  controller: AbortController,
) {
  // A copy per turn: the team is this turn's, and a teammate's own turn runs
  // without one (no nesting).
  const context: StudioAssistantContext = { ...input.context, team: undefined };
  const attachments = input.attachments ?? [];
  const images = attachments.filter((item) => item.encoding === "base64" && (STUDIO_ASSISTANT_IMAGE_TYPES as readonly string[]).includes(item.type));
  const texts = attachments.filter((item) => item.encoding === "text");
  const transcriptFile = metaFile(context, "assistant-transcript.json");
  const transcript = await readJson<StudioAssistantTurn[]>(transcriptFile, []);
  const userTurn: StudioAssistantTurn = {
    id: randomUUID(), role: "user", text: input.message, steps: [], provider: input.provider, model: input.model, error: null, createdAt: new Date().toISOString(),
    checkpointId: input.checkpointId ?? null,
    ...(attachments.length
      ? { attachments: attachments.map((item) => ({ name: item.name, type: item.type, size: item.encoding === "base64" ? Math.round((item.data.length * 3) / 4) : item.data.length })) }
      : {}),
  };
  const turn: StudioAssistantTurn = {
    id: randomUUID(), role: "assistant", text: "", steps: [], provider: input.provider, model: input.model, error: null, createdAt: new Date().toISOString(),
  };
  transcript.push(userTurn);
  // Saved before the model starts: the page reloads the transcript while the
  // assistant works, and a message that only lived in memory vanished.
  await writeJson(transcriptFile, transcript.slice(-200));
  let liveThinking = "";
  let live = "";
  let activity = "";
  const snapshot = (): StudioAssistantTurn => ({
    ...turn,
    steps: [...turn.steps],
    ...(live ? { live: live.trimStart() } : {}),
    ...(liveThinking ? { liveThinking } : {}),
    ...(activity ? { activity } : {}),
  });
  liveTurns.set(context.workspaceId, snapshot);
  const publish = (done: boolean) => studioHub.broadcast(context.workspaceId, { type: "assistant", turn: done ? { ...turn, steps: [...turn.steps] } : snapshot(), done });
  studioHub.broadcast(context.workspaceId, { type: "assistant", turn: userTurn, done: true });

  // Every model call in the turn adds up; the turn is recorded once, so
  // fractions of a cent are not lost to rounding call by call.
  const usageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 as number | null, model: input.model };
  const onUsage = async (usage: StudioAiUsage) => {
    usageTotals.inputTokens += usage.inputTokens;
    usageTotals.cachedInputTokens += usage.cachedInputTokens;
    usageTotals.outputTokens += usage.outputTokens;
    usageTotals.model = usage.model || usageTotals.model;
    usageTotals.costUsd = usage.costUsd === null || usageTotals.costUsd === null ? null : usageTotals.costUsd + usage.costUsd;
  };

  const finish = async () => {
    if (usageTotals.inputTokens || usageTotals.cachedInputTokens || usageTotals.outputTokens) {
      turn.usage = {
        inputTokens: usageTotals.inputTokens + usageTotals.cachedInputTokens,
        outputTokens: usageTotals.outputTokens,
        costUsd: usageTotals.costUsd,
      };
      try {
        await context.onUsage?.({
          provider: input.provider,
          model: usageTotals.model,
          inputTokens: usageTotals.inputTokens,
          cachedInputTokens: usageTotals.cachedInputTokens,
          outputTokens: usageTotals.outputTokens,
          costUsd: usageTotals.costUsd,
        });
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error), workspaceId: context.workspaceId }, "studio assistant usage not recorded");
      }
    }
    // The reply is saved before the turn stops counting as running, so a
    // reload or a "New chat" in between never sees it missing or revives it.
    transcript.push(turn);
    try {
      await writeJson(transcriptFile, transcript.slice(-200));
    } catch (error) {
      // A full disk on a phone must not take the whole server down.
      logger.warn({ error: error instanceof Error ? error.message : String(error), workspaceId: context.workspaceId }, "studio assistant transcript not saved");
    }
    running.delete(context.workspaceId);
    liveTurns.delete(context.workspaceId);
    publish(true);
  };

  const onStep = (step: StudioAssistantStep) => {
    activity = "";
    turn.steps.push(step);
    publish(false);
  };
  // Said before a tool runs, so a long install shows what it is waiting on.
  const onToolStart = (name: string, rawInput: unknown) => {
    activity = describeActivity(name, rawInput);
    publish(false);
  };
  // Text the model is still writing (and its thinking); shown live, then
  // replaced by the finished reply. Updates go out in small batches so the
  // panel redraws smoothly.
  let lastLivePublish = 0;
  let pendingLive: NodeJS.Timeout | null = null;
  const publishLive = () => {
    const now = Date.now();
    const wait = 60 - (now - lastLivePublish);
    if (wait > 0) {
      if (!pendingLive) pendingLive = setTimeout(() => { pendingLive = null; publishLive(); }, wait);
      return;
    }
    lastLivePublish = now;
    publish(false);
  };
  const onDelta = (delta: string) => {
    live += delta;
    publishLive();
  };
  const onThinkingDelta = (delta: string) => {
    liveThinking += delta;
    publishLive();
  };
  const onThought = (text: string) => {
    liveThinking = "";
    const thought = text.trim();
    if (!thought) return;
    const firstLine = thought.split("\n").find((line) => line.trim())?.replace(/^[#*\s]+/, "").slice(0, 140) ?? "Thought";
    turn.steps.push({ tool: "think", summary: firstLine, ok: true, detail: clip(thought, 6000) });
    publish(false);
  };
  const onText = (text: string) => {
    live = "";
    if (!text.trim()) return;
    turn.text = turn.text ? `${turn.text}\n\n${text.trim()}` : text.trim();
    // Kept in order with the tool steps, so the chat reads as it happened.
    turn.steps.push({ tool: "say", summary: text.trim(), ok: true, detail: null });
    publish(false);
  };

  // Teammates: each runs its task in its own short conversation with the
  // same tools, reporting steps into this turn under its name.
  if (input.team?.length) {
    context.team = {
      members: input.team,
      delegate: async (member, task, signal) => {
        const who = modelLabel(member.model);
        const texts: string[] = [];
        const mateContext: StudioAssistantContext = { ...context, team: undefined };
        const common = {
          context: mateContext,
          prompt: `${task}\n\n<project_state>\n${await projectOverview(context)}\n</project_state>`,
          images: [] as StudioAssistantAttachmentInput[],
          model: member.model,
          credentials: member.credentials,
          signal,
          onStep: (step: StudioAssistantStep) => onStep({ ...step, summary: `${who} · ${step.summary}` }),
          onToolStart,
          onText: (text: string) => { texts.push(text); },
          onDelta: () => undefined,
          onThinkingDelta: () => undefined,
          onThought: () => undefined,
          onUsage,
          historyName: `teammate-${member.model.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`,
          fresh: true,
          systemExtra: TEAMMATE_SYSTEM,
          maxSteps: 20,
        };
        activity = `${who} is working`;
        publish(false);
        if (member.provider === "anthropic") await runAnthropic(common);
        else if (member.provider === "free") await runFreeModels(common);
        else await runOpenAiCompatible({ ...common, provider: member.provider });
        return texts.join("\n\n").trim() || "(No report: the teammate finished without writing one.)";
      },
    };
  }
  // Earlier turns from every provider, for a model that was just switched in.
  const earlier = transcript.slice(0, -1);

  void (async () => {
    try {
      const attachedText = texts.map((item) => `\n\nAttached file "${item.name}":\n\`\`\`\n${item.data}\n\`\`\``).join("");
      const message = input.message || (images.length ? "Look at the attached image." : "See the attached files.");
      const prompt = `${message}${attachedText}\n\n<project_state>\n${await projectOverview(context)}\n</project_state>`;
      const common = { ...input, context, prompt, images, signal: controller.signal, onStep, onToolStart, onText, onDelta, onThinkingDelta, onThought, onUsage, transcript: earlier };
      if (input.provider === "anthropic") {
        await runAnthropic(common);
      } else if (input.provider === "free") {
        await runFreeModels(common);
      } else {
        await runOpenAiCompatible(common);
      }
    } catch (error) {
      turn.error = describeProviderError(error, controller.signal.aborted);
      logger.warn({ error: turn.error, workspaceId: context.workspaceId }, "studio assistant turn failed");
    } finally {
      if (pendingLive) clearTimeout(pendingLive);
      await finish().catch((error) => {
        running.delete(context.workspaceId);
        liveTurns.delete(context.workspaceId);
        logger.warn({ error: error instanceof Error ? error.message : String(error), workspaceId: context.workspaceId }, "studio assistant turn did not finish cleanly");
      });
    }
  })();
  publish(false);
  return { userTurn, turn };
}

/** Tool calls in the last assistant message that no tool result answered. */
function danglingAnthropicToolUses(messages: Anthropic.Beta.BetaMessageParam[]): string[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return [];
  return last.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
}

function describeProviderError(error: unknown, aborted: boolean): string {
  if (aborted) return "Stopped.";
  if (error instanceof PuterHttpError) return describePuterError(error, "The free model").message;
  if (error instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Check it in Studio's AI settings.";
  if (error instanceof Anthropic.PermissionDeniedError) return "This Anthropic key can't use that model.";
  if (error instanceof Anthropic.NotFoundError) return "Anthropic doesn't know that model name.";
  if (error instanceof Anthropic.RateLimitError) return "Anthropic is rate limiting this key. Wait a moment and try again.";
  if (error instanceof Anthropic.APIError) {
    if (error.status === 529 || (error.status ?? 0) >= 500) return "Anthropic is overloaded or had a server error. Try again in a minute.";
    // The SDK's message repeats the status and the raw JSON body.
    const detail = (error.error as { error?: { message?: string } } | undefined)?.error?.message ?? error.message;
    return `Anthropic refused the request: ${detail}`.replace(/\s+/g, " ").trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/** History on disk keeps a note where an image was, never the image itself. */
function withoutImages<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    const content = (message.content as Array<Record<string, unknown>>).map((part) =>
      part.type === "image" || part.type === "image_url" ? { type: "text", text: "[an image was attached here]" } : part,
    );
    return { ...message, content };
  });
}

async function runAnthropic(input: {
  context: StudioAssistantContext;
  prompt: string;
  images: StudioAssistantAttachmentInput[];
  model: string;
  thinking?: StudioThinkingLevel;
  credentials: ProviderCredentials;
  signal: AbortSignal;
  onStep: (step: StudioAssistantStep) => void;
  onToolStart: (name: string, rawInput: unknown) => void;
  onText: (text: string) => void;
  onDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onThought: (text: string) => void;
  onUsage: (usage: StudioAiUsage) => Promise<void>;
  /** Where this conversation's messages live (a teammate's task gets its own). */
  historyName?: string;
  /** Start with no history (a teammate's task). */
  fresh?: boolean;
  /** Added to the system prompt (a teammate's brief). */
  systemExtra?: string;
  maxSteps?: number;
  /** Everyone's earlier turns, to seed a provider that was just switched to. */
  transcript?: StudioAssistantTurn[];
}) {
  const { context } = input;
  const baseURL = input.credentials.baseUrl || process.env.PAPERCLIP_STUDIO_ANTHROPIC_BASE_URL || undefined;
  const client = new Anthropic({
    apiKey: input.credentials.apiKey,
    // Never the server's own ANTHROPIC_AUTH_TOKEN, which the SDK would add
    // and send to whatever base URL the key names.
    authToken: null,
    baseURL,
    maxRetries: 2,
  });
  const historyFile = metaFile(context, input.historyName ?? "assistant-anthropic.json");
  let messages = input.fresh ? [] : await readJson<Anthropic.Beta.BetaMessageParam[]>(historyFile, []);
  // A fresh conversation instead of trimming: earlier turns are never edited.
  if (JSON.stringify(messages).length > MAX_HISTORY_CHARS) messages = [];
  // Switched to this provider mid-chat: carry the conversation over as text.
  if (!input.fresh && input.transcript && spokenUserTurns(messages) < input.transcript.filter((turn) => turn.role === "user").length) {
    messages = historyFromTranscript(input.transcript);
  }
  // A turn cut off mid-step (length limit, Stop, a restart) leaves tool calls
  // without results, and the API then refuses every later message. They are
  // answered as interrupted at the start of this message.
  const interrupted = danglingAnthropicToolUses(messages).map((id): Anthropic.Beta.BetaToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: id,
    content: "This step was interrupted before it finished.",
    is_error: true,
  }));
  messages.push({
    role: "user",
    content: input.images.length || interrupted.length
      ? [
          ...interrupted,
          ...input.images.map((image) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: image.type as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: image.data },
          })),
          { type: "text" as const, text: input.prompt },
        ]
      : input.prompt,
  });

  // Large file writes stream in as they are written. Proxies behind a custom
  // base URL may not accept the field, so it is only sent to Anthropic.
  const tools: Anthropic.Beta.BetaTool[] = toolsFor(context).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Beta.BetaTool.InputSchema,
    ...(baseURL ? {} : { eager_input_streaming: true }),
  }));
  const useFallbacks = FALLBACK_MODELS.has(input.model);
  // High unless the person picked another level the model takes.
  const effort = supportsEffort(input.model) ? thinkingLevelFor("anthropic", input.model, input.thinking) ?? "high" : null;
  let jsonRetries = 0;
  const maxSteps = input.maxSteps ?? MAX_STEPS;

  for (let step = 0; step < maxSteps; step += 1) {
    if (input.signal.aborted) throw new Error("Stopped.");
    const stream = client.beta.messages.stream(
      {
        model: input.model,
        // The deepest levels think and act at length; they get room to finish.
        max_tokens: effort === "xhigh" || effort === "max" ? 64000 : 32000,
        system: [{ type: "text", text: input.systemExtra ? `${systemPrompt(context)}\n\n${input.systemExtra}` : systemPrompt(context), cache_control: { type: "ephemeral" } }],
        tools,
        messages,
        // Thinking is shown in the panel as it happens (summarized).
        ...(supportsAdaptiveThinking(input.model) ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
        ...(effort ? { output_config: { effort } } : {}),
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: input.signal },
    );
    stream.on("text", (delta) => input.onDelta(delta));
    stream.on("thinking", (delta) => input.onThinkingDelta(delta));
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await stream.finalMessage();
      jsonRetries = 0;
    } catch (error) {
      // A stopped or failed call was still billed for what it used so far.
      const partial = (stream as unknown as { currentMessage?: Anthropic.Beta.BetaMessage }).currentMessage;
      if (partial?.usage) {
        await input.onUsage({
          provider: "anthropic",
          model: partial.model || input.model,
          ...claudeBilledSpend(partial.model || input.model, partial.usage as ClaudeApiUsage),
        }).catch(() => undefined);
      }
      // A streamed tool input that isn't JSON at all: ask again (a few times).
      if (error instanceof Anthropic.APIError || input.signal.aborted || jsonRetries >= 2) throw error;
      jsonRetries += 1;
      continue;
    }
    // Keep every block (thinking, fallback markers) exactly as returned.
    messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
    await writeJson(historyFile, withoutImages(messages));
    // Every attempt is billed (a declined one and a fallback model's too).
    await input.onUsage({
      provider: "anthropic",
      model: response.model || input.model,
      ...claudeBilledSpend(response.model || input.model, response.usage as ClaudeApiUsage),
    });

    for (const block of response.content) {
      if (block.type === "thinking") input.onThought(block.thinking);
      if (block.type === "text") input.onText(block.text);
    }
    if (response.stop_reason === "refusal") {
      const reason = response.stop_details && "explanation" in response.stop_details ? response.stop_details.explanation : null;
      throw new Error(`Claude declined this request${reason ? `: ${reason}` : "."}`);
    }
    if (response.stop_reason === "max_tokens") {
      input.onText("(I hit the length limit for one reply. Ask me to continue.)");
      return;
    }
    if (response.stop_reason === "pause_turn") continue;
    const toolUses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) return;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (input.signal.aborted) throw new Error("Stopped.");
      input.onToolStart(use.name, use.input);
      const outcome = await runTool(context, use.name, use.input, input.signal);
      input.onStep(outcome.step);
      results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.output, ...(outcome.ok ? {} : { is_error: true }) });
    }
    // All results of one turn go back together, in a single user message.
    messages.push({ role: "user", content: results });
    await writeJson(historyFile, withoutImages(messages));
  }
  input.onText(`(I stopped after ${maxSteps} steps. Ask me to keep going.)`);
}

type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

async function runOpenAiCompatible(input: {
  context: StudioAssistantContext;
  prompt: string;
  images: StudioAssistantAttachmentInput[];
  provider: StudioAiProvider;
  model: string;
  thinking?: StudioThinkingLevel;
  credentials: ProviderCredentials;
  signal: AbortSignal;
  onStep: (step: StudioAssistantStep) => void;
  onToolStart: (name: string, rawInput: unknown) => void;
  onText: (text: string) => void;
  onUsage: (usage: StudioAiUsage) => Promise<void>;
  historyName?: string;
  fresh?: boolean;
  systemExtra?: string;
  maxSteps?: number;
  transcript?: StudioAssistantTurn[];
}) {
  const { context } = input;
  const info = STUDIO_AI_PROVIDER_INFO[input.provider];
  const baseUrl = (input.credentials.baseUrl || info.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Add the API's base URL in Studio's AI settings.");
  const historyFile = metaFile(context, input.historyName ?? `assistant-${input.provider}.json`);
  let messages = input.fresh ? [] : await readJson<ChatMessage[]>(historyFile, []);
  if (JSON.stringify(messages).length > MAX_HISTORY_CHARS) messages = [];
  if (!input.fresh && input.transcript && spokenUserTurns(messages) < input.transcript.filter((turn) => turn.role === "user").length) {
    messages = historyFromTranscript(input.transcript);
  }
  // Tool calls left unanswered by an interrupted turn get an "interrupted"
  // result, or the provider refuses the whole conversation.
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "assistant" && lastMessage.tool_calls?.length) {
    for (const call of lastMessage.tool_calls) {
      messages.push({ role: "tool", tool_call_id: call.id, content: "This step was interrupted before it finished." });
    }
  }
  messages.push({
    role: "user",
    content: input.images.length
      ? [
          ...input.images.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.type};base64,${image.data}` } })),
          { type: "text" as const, text: input.prompt },
        ]
      : input.prompt,
  });
  const tools = toolsFor(context).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  const reasoningEffort = thinkingLevelFor(input.provider, input.model, input.thinking);
  const system = input.systemExtra ? `${systemPrompt(context)}\n\n${input.systemExtra}` : systemPrompt(context);
  const maxSteps = input.maxSteps ?? MAX_STEPS;

  for (let step = 0; step < maxSteps; step += 1) {
    if (input.signal.aborted) throw new Error("Stopped.");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: input.signal,
      headers: {
        authorization: `Bearer ${input.credentials.apiKey}`,
        "content-type": "application/json",
        ...(input.provider === "openrouter" ? { "X-Title": "Automa Studio" } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "system", content: system }, ...messages],
        tools,
        tool_choice: "auto",
        // OpenRouter adds the call's cost to its usage report when asked.
        ...(input.provider === "openrouter" ? { usage: { include: true } } : {}),
        // OpenRouter takes one reasoning setting for every model it routes to.
        ...(reasoningEffort ? (input.provider === "openrouter" ? { reasoning: { effort: reasoningEffort } } : { reasoning_effort: reasoningEffort }) : {}),
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string };
        detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? detail;
      } catch {
        // not JSON
      }
      if (response.status === 401 || response.status === 403) throw new Error(`${info.name} rejected the API key (${response.status}). ${detail}`.trim());
      throw new Error(`${info.name} error ${response.status}: ${detail}`);
    }
    const data = JSON.parse(text) as {
      model?: string;
      choices?: Array<{ message?: ChatMessage; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    if (data.usage) {
      const cached = data.usage.prompt_tokens_details?.cached_tokens ?? 0;
      const tokens = {
        inputTokens: Math.max(0, (data.usage.prompt_tokens ?? 0) - cached),
        cachedInputTokens: cached,
        outputTokens: data.usage.completion_tokens ?? 0,
      };
      await input.onUsage({
        provider: input.provider,
        model: data.model || input.model,
        ...tokens,
        // OpenRouter reports the cost; for other providers it is worked out
        // from the model's price, or left unpriced when that isn't known.
        costUsd: typeof data.usage.cost === "number" ? data.usage.cost : estimateApiCostUsd(data.model || input.model, tokens),
      });
    }
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error(`${info.name} sent an empty reply.`);
    const assistant: ChatMessage = { role: "assistant", content: message.content ?? "", ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) };
    messages.push(assistant);
    await writeJson(historyFile, withoutImages(messages));
    const replyText = typeof message.content === "string" ? message.content : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (replyText) input.onText(replyText);
    if (!message.tool_calls?.length) return;
    for (const call of message.tool_calls) {
      let args: unknown = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = null;
      }
      if (args !== null) input.onToolStart(call.function.name, args);
      const outcome = args === null
        ? { ok: false, output: "The tool arguments were not valid JSON.", step: { tool: call.function.name, summary: call.function.name, ok: false, detail: "Invalid arguments" } }
        : await runTool(context, call.function.name, args, input.signal);
      input.onStep(outcome.step);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.output });
    }
    await writeJson(historyFile, withoutImages(messages));
  }
  input.onText(`(I stopped after ${maxSteps} steps. Ask me to keep going.)`);
}

/**
 * The free models (no key): the same tool loop over the keyless chat service,
 * streaming text and thinking live. Stays on the chosen model: a provider that
 * refuses the tool history gets it as text, one that takes no tools answers
 * without them, a busy one is retried.
 */
async function runFreeModels(input: {
  context: StudioAssistantContext;
  prompt: string;
  images: StudioAssistantAttachmentInput[];
  model: string;
  thinking?: StudioThinkingLevel;
  credentials: ProviderCredentials;
  signal: AbortSignal;
  onStep: (step: StudioAssistantStep) => void;
  onToolStart: (name: string, rawInput: unknown) => void;
  onText: (text: string) => void;
  onDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onThought: (text: string) => void;
  onUsage: (usage: StudioAiUsage) => Promise<void>;
  historyName?: string;
  fresh?: boolean;
  systemExtra?: string;
  maxSteps?: number;
  transcript?: StudioAssistantTurn[];
}) {
  const { context } = input;
  const label = modelLabel(input.model);
  const historyFile = metaFile(context, input.historyName ?? "assistant-free.json");
  let messages = input.fresh ? [] : await readJson<ChatMessage[]>(historyFile, []);
  if (JSON.stringify(messages).length > MAX_HISTORY_CHARS) messages = [];
  if (!input.fresh && input.transcript && spokenUserTurns(messages) < input.transcript.filter((turn) => turn.role === "user").length) {
    messages = historyFromTranscript(input.transcript);
  }
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "assistant" && lastMessage.tool_calls?.length) {
    for (const call of lastMessage.tool_calls) messages.push({ role: "tool", tool_call_id: call.id, content: "This step was interrupted before it finished." });
  }
  const level = readThinkingLevel(input.thinking === "max" ? "xhigh" : input.thinking);
  const promptText = level ? `${input.prompt}\n\n${thinkingInstruction(level)}` : input.prompt;
  messages.push({
    role: "user",
    content: input.images.length
      ? [...input.images.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.type};base64,${image.data}` } })), { type: "text" as const, text: promptText }]
      : promptText,
  });
  const tools: PuterTool[] = toolsFor(context).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> } }));
  const system = input.systemExtra ? `${systemPrompt(context)}\n\n${input.systemExtra}` : systemPrompt(context);
  const maxSteps = input.maxSteps ?? MAX_STEPS;
  let useTools = true;
  let textHistory = false;
  let retries = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    if (input.signal.aborted) throw new Error("Stopped.");
    const history = (textHistory ? toolHistoryAsText(messages as PuterMessage[]) : (messages as PuterMessage[]));
    const sent: PuterMessage[] = [{ role: "system", content: system }, ...history];
    let text = "";
    let reasoning = "";
    const calls: PuterToolCall[] = [];
    let usage: PuterUsage = { inputTokens: 0, outputTokens: 0 };
    const splitter = createThinkingTagSplitter();
    const emit = (piece: { channel: "text" | "thinking"; text: string }) => {
      if (piece.channel === "thinking") { reasoning += piece.text; input.onThinkingDelta(piece.text); }
      else { text += piece.text; input.onDelta(piece.text); }
    };
    try {
      for await (const event of puterStream(sent, { model: input.model, tools: useTools && tools.length ? tools : undefined, signal: input.signal })) {
        if (event.type === "text") for (const piece of splitter.push(event.text)) emit(piece);
        else if (event.type === "reasoning") { reasoning += event.text; input.onThinkingDelta(event.text); }
        else if (event.type === "tool_use") calls.push({ id: event.id, type: "function", function: { name: event.name, arguments: JSON.stringify(event.input ?? {}) } });
        else if (event.type === "done") usage = event.usage;
      }
      for (const piece of splitter.flush()) emit(piece);
    } catch (error) {
      if (input.signal.aborted) throw new Error("Stopped.");
      if (!(error instanceof PuterHttpError)) throw error;
      if (!textHistory && messages.some((m) => m.role === "tool")) { textHistory = true; step -= 1; continue; }
      if (useTools && error.status !== 429) { useTools = false; input.onStep({ tool: "say", summary: `(${label} did not take the tools; continuing in text.)`, ok: true, detail: null }); step -= 1; continue; }
      if (retries < 3 && isTransientPuterError(error)) { retries += 1; await new Promise((r) => setTimeout(r, 1500 * retries)); step -= 1; continue; }
      throw describePuterError(error, label, retries);
    }
    await input.onUsage({ provider: "free", model: input.model, inputTokens: usage.inputTokens, cachedInputTokens: 0, outputTokens: usage.outputTokens, costUsd: 0 });
    if (reasoning.trim()) input.onThought(reasoning);
    const spoken = text.trim();
    if (spoken) input.onText(spoken);
    const assistant: ChatMessage = {
      role: "assistant",
      content: spoken || (calls.length ? `Calling ${[...new Set(calls.map((call) => call.function.name))].join(", ")}.` : ""),
      ...(calls.length ? { tool_calls: calls } : {}),
    };
    messages.push(assistant);
    await writeJson(historyFile, withoutImages(messages));
    if (!calls.length) return;
    for (const call of calls) {
      if (input.signal.aborted) throw new Error("Stopped.");
      let args: unknown = {};
      try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = null; }
      if (args !== null) input.onToolStart(call.function.name, args);
      const outcome = args === null
        ? { ok: false, output: "The tool arguments were not valid JSON.", step: { tool: call.function.name, summary: call.function.name, ok: false, detail: "Invalid arguments" } }
        : await runTool(context, call.function.name, args, input.signal);
      input.onStep(outcome.step);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.output });
    }
    await writeJson(historyFile, withoutImages(messages));
  }
  input.onText(`(I stopped after ${maxSteps} steps. Ask me to keep going.)`);
}

/** Confines a model-supplied path to the project (exported for tests). */
export async function assistantPathInside(companyId: string, workspaceId: string, relative: string) {
  return resolveInside(studioWorkspaceDirs(companyId, workspaceId).files, relative);
}

const COMPLETION_SYSTEM = `You are a code completion engine inside a code editor. You get a file with the marker <CURSOR> where the person is typing. Reply with only the text to insert at <CURSOR>: no explanations, no code fences, no repeated text from before the cursor. Finish the current line, and add up to a few more lines when the next lines are obvious. Match the file's language, indentation, and style. If nothing useful fits, reply with nothing.`;

/** Removes fences and any text that repeats what is already before the cursor. */
export function cleanCompletion(raw: string, prefix: string): string {
  let text = raw.replace(/^```[\w+-]*\n?/, "").replace(/\n?```\s*$/, "");
  const currentLine = prefix.slice(prefix.lastIndexOf("\n") + 1);
  if (currentLine.trim() && text.startsWith(currentLine)) text = text.slice(currentLine.length);
  const lines = text.split("\n");
  return lines.slice(0, 8).join("\n").replace(/\s+$/, "");
}

/**
 * A short inline suggestion for the code at the cursor (the grey text in the
 * editor), from a fast model with the person's own key.
 */
export async function completeCode(input: {
  provider: StudioAiProvider;
  model: string;
  credentials: ProviderCredentials;
  path: string;
  prefix: string;
  suffix: string;
  signal?: AbortSignal;
  /** Tokens the suggestion used, for Costs. */
  onUsage?: (usage: StudioAiUsage) => void;
}): Promise<string> {
  const prompt = `File: ${input.path}\n\n${input.prefix}<CURSOR>${input.suffix}`;
  if (input.provider === "anthropic") {
    const client = new Anthropic({
      apiKey: input.credentials.apiKey,
      baseURL: input.credentials.baseUrl || process.env.PAPERCLIP_STUDIO_ANTHROPIC_BASE_URL || undefined,
      maxRetries: 0,
      timeout: 20_000,
    });
    // Speed over depth: thinking off where the model accepts that (at low
    // effort); other models keep adaptive thinking at low effort.
    const thinkingOff = input.model === "claude-haiku-5-5" || input.model === "claude-opus-5";
    const response = await client.messages.create(
      {
        model: input.model,
        max_tokens: 400,
        system: COMPLETION_SYSTEM,
        messages: [{ role: "user", content: prompt }],
        ...(thinkingOff ? { thinking: { type: "disabled" as const } } : {}),
        ...(supportsEffort(input.model) ? { output_config: { effort: "low" as const } } : {}),
      },
      { signal: input.signal },
    );
    input.onUsage?.({
      provider: input.provider,
      model: response.model || input.model,
      ...claudeBilledSpend(response.model || input.model, response.usage as ClaudeApiUsage),
    });
    if (response.stop_reason === "refusal") return "";
    const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    return cleanCompletion(text, input.prefix);
  }
  if (input.provider === "free") {
    const reply = await puterComplete(
      [{ role: "system", content: COMPLETION_SYSTEM }, { role: "user", content: prompt }],
      { model: input.model, retries: 1, signal: input.signal ?? AbortSignal.timeout(20_000) },
    );
    input.onUsage?.({ provider: "free", model: reply.model, inputTokens: reply.usage.inputTokens, cachedInputTokens: 0, outputTokens: reply.usage.outputTokens, costUsd: 0 });
    return cleanCompletion(reply.text, input.prefix);
  }
  const info = STUDIO_AI_PROVIDER_INFO[input.provider];
  const baseUrl = (input.credentials.baseUrl || info.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Add the API's base URL in Studio's AI settings.");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: input.signal ?? AbortSignal.timeout(20_000),
    headers: {
      authorization: `Bearer ${input.credentials.apiKey}`,
      "content-type": "application/json",
      ...(input.provider === "openrouter" ? { "X-Title": "Automa Studio" } : {}),
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: "system", content: COMPLETION_SYSTEM },
        { role: "user", content: prompt },
      ],
      max_tokens: 200,
      ...(input.provider === "openrouter" ? { usage: { include: true } } : {}),
    }),
  });
  if (!response.ok) throw new Error(`${info.name} error ${response.status}`);
  const data = (await response.json()) as {
    model?: string;
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  if (data.usage) {
    const tokens = { inputTokens: data.usage.prompt_tokens ?? 0, cachedInputTokens: 0, outputTokens: data.usage.completion_tokens ?? 0 };
    input.onUsage?.({
      provider: input.provider,
      model: data.model || input.model,
      ...tokens,
      costUsd: typeof data.usage.cost === "number" ? data.usage.cost : estimateApiCostUsd(data.model || input.model, tokens),
    });
  }
  return cleanCompletion(data.choices?.[0]?.message?.content ?? "", input.prefix);
}
