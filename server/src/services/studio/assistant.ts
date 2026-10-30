import { conflict } from "../../errors.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  moanSystemPrompt,
  resolveFreeModel,
  STUDIO_ASSISTANT_IMAGE_TYPES,
  STUDIO_AI_PROVIDER_INFO,
  studioLanguage,
  studioThinkingLevels,
  STUDIO_TEAM_LEAD_ID,
  type StudioAiProvider,
  type StudioAssistantAttachmentInput,
  type StudioAssistantStep,
  type StudioAssistantTurn,
  type StudioTeamAgent,
  type StudioThinkingLevel,
  type StudioTokenUsage,
} from "@paperclipai/shared";
import { AUTOMA_ABOUT_FOR_AGENTS, claudeBilledSpend, estimateApiCostUsd, type ClaudeApiUsage } from "@paperclipai/shared";
import {
  describePuterError,
  formatSafetyVerdict,
  isLastingPuterError,
  isTransientPuterError,
  mayHoldTextToolCalls,
  parseTextToolCalls,
  puterModelTakesTools,
  puterComplete,
  puterStream,
  PuterHttpError,
  toolHistoryAsText,
  type PuterMessage,
  type PuterTool,
  type PuterToolCall,
  type PuterUsage,
} from "@paperclipai/shared/puter-ai";
import { createThinkingTagSplitter, readThinkingLevel, thinkingInstruction } from "../../adapters/free-models/thinking.js";
import { modelLabel } from "../../adapters/free-models/execute.js";
import { webFetch, webSearch } from "../../adapters/free-models/web.js";
import { currentText, listEdits, recordEdit, undoEdit } from "./edits.js";
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
import { formatPageReport, pageReportSummary, requestPageReport, staticPageOutline } from "./page-probe.js";
import { formatTeamNews, formatTeamTalk, TeamBoard, teammateLabel } from "./team-board.js";

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

/** One model call added to a running total, the way the turn's usage counts it (cached input included). */
/** A step with the time it was taken, for the Stats tab's latest moves. */
function stamped(step: StudioAssistantStep): StudioAssistantStep {
  return step.at ? step : { ...step, at: new Date().toISOString() };
}

function addTokenUsage(total: StudioTokenUsage | undefined, usage: StudioAiUsage, worthUsd: number | null): StudioTokenUsage {
  const base = total ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const worth = worthUsd ?? usage.costUsd;
  return {
    inputTokens: base.inputTokens + usage.inputTokens + usage.cachedInputTokens,
    outputTokens: base.outputTokens + usage.outputTokens,
    costUsd: base.costUsd === null || usage.costUsd === null ? null : base.costUsd + usage.costUsd,
    ...(worth === null && base.equivalentUsd === undefined ? {} : { equivalentUsd: (base.equivalentUsd ?? 0) + (worth ?? 0) }),
  };
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
  /** What a call's tokens cost at paid list prices (a free model's would-have-cost); null when unknown. */
  worthUsd?: (usage: StudioAiUsage) => number | null;
  /** The reply is done (saved and sent to everyone); for news to the person's phone. */
  onFinished?: (turn: StudioAssistantTurn) => void;
  /** Other models the lead can hand tasks to this turn (set per turn, never nested). */
  team?: TeamRuntime;
  /** On a teammate's own turn: its line to the others working on the same job. */
  teamChannel?: TeamChannel;
  /** Who is acting, for the edit log ("assistant" for the lead, a teammate's name). */
  actor?: string;
}

interface TeamChannel {
  /** Posts to a teammate (by name or role), the lead, or everyone, and says where it went. */
  post: (to: string | undefined, message: string) => { output: string; summary: string };
  /** The lines for this teammate since its last tool call, ready to append to a tool result; null when none. */
  news: () => string | null;
}

/** A model that works for the lead: its provider, name, and the key that pays for it. */
export interface StudioTeamMember {
  provider: StudioAiProvider;
  model: string;
  credentials: ProviderCredentials;
}

interface TeamRuntime {
  members: StudioTeamMember[];
  /** Runs one task on a teammate (in a role, when given) and returns its written report. */
  delegate: (member: StudioTeamMember, task: string, signal: AbortSignal, options?: { role?: string | null }) => Promise<string>;
  /** Lines in the team chat so far, to find what was said during a job. */
  chatLength: () => number;
  /** What the teammates told each other since a point in the chat, for the lead; null when nothing. */
  talkSince: (index: number) => string | null;
}

const MESSAGE_TEAM_TOOL = {
  name: "message_team",
  description: "Send a short message to the other teammates working on this job right now, to one of them, or to the lead: agree on file names, APIs, routes, ports and data shapes, say what you finished, or ask a teammate for something. Their messages to you arrive with your tool results. The person reads the team chat too.",
  schema: z.object({ to: z.string().max(80).optional(), message: z.string().min(1).max(4000) }),
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "A teammate's name or role, \"lead\", or leave it out for everyone" },
      message: { type: "string", description: "What to tell them" },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

const MAX_TEAM_ASSIGNMENTS = 10;

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

function runTeamTool(members: StudioTeamMember[]) {
  const list = members.map((m, i) => `${i + 1}. ${modelLabel(m.model)} (${m.provider}; id "${m.model}")`).join("; ");
  return {
    name: "run_team",
    description: `Put several teammates to work at the same time, each in a role with its own task, and wait until all of them finish; you get every report together and then carry on. Teammates: ${list}. The same teammate can take more than one assignment. Give each assignment a role (e.g. "backend: API and database in server.py") and a self-contained task that names the files it owns, so parallel work does not collide. Up to ${MAX_TEAM_ASSIGNMENTS} assignments.`,
    schema: z.object({
      assignments: z.array(z.object({
        teammate: z.string().min(1),
        role: z.string().min(1).max(200),
        task: z.string().min(1).max(20_000),
      })).min(1).max(MAX_TEAM_ASSIGNMENTS),
    }),
    parameters: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TEAM_ASSIGNMENTS,
          items: {
            type: "object",
            properties: {
              teammate: { type: "string", description: "The teammate's number, model id, or a word from its name" },
              role: { type: "string", description: "Its role on the team for this job" },
              task: { type: "string", description: "The whole task, self-contained, with the files it owns" },
            },
            required: ["teammate", "role", "task"],
            additionalProperties: false,
          },
        },
      },
      required: ["assignments"],
      additionalProperties: false,
    },
  };
}

/** The tools this turn offers: the project tools, plus the team tools for a lead with a team, or the team chat for a teammate. */
function toolsFor(context: StudioAssistantContext) {
  if (context.teamChannel) return [...TOOLS, MESSAGE_TEAM_TOOL];
  return context.team?.members.length ? [...TOOLS, askTeammateTool(context.team.members), runTeamTool(context.team.members)] : TOOLS;
}

/**
 * A safety net, not a budget: the model decides when the job is done and
 * keeps going as long as it is making progress. Repeating the same call is
 * what stops a run early (see RunGuard).
 */
const MAX_STEPS = 400;
/** Replies cut off by the length limit are continued automatically, this many times in a row. */
const MAX_LENGTH_CONTINUATIONS = 20;
/** A model that stops without a word to the person is asked to finish, this many times. */
const MAX_SILENT_FINISH_NUDGES = 2;
/** The same tool call with the same input past this many times is a loop. */
const MAX_IDENTICAL_CALLS = 3;
/** Tools that change the project: after one, reading or running the same thing again can give a new result. */
const CHANGING_TOOLS = new Set(["write_file", "edit_file", "delete_path", "undo_edit", "ask_teammate", "run_team"]);
/** Same-model retries when a free model is busy at its provider, and the wait between them (short under test). */
const FREE_BUSY_RETRIES = 4;
const FREE_RETRY_BASE_MS = process.env.VITEST ? 10 : 2500;
/** A connection to the free-model service that dropped or never opened (common on a phone), as in the agents' free engine. */
const DROPPED_MESSAGE = /^(?:fetch failed|terminated)$|socket hang up|other side closed|ECONNRESET/i;
const DROPPED_CODE = /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/;
const CONTINUE_PROMPT = "(Automa) Your reply was cut off by the length limit. Continue exactly where you left off. If you were writing a large file, write it in parts (write_file for the first part, then edit_file to add the rest).";
const SILENT_FINISH_PROMPT = "(Automa) You stopped without saying anything to the person. If any part of the task is still undone, finish it with your tools now; then reply with what you did, what works, and how to use it.";

/** A dropped connection as the busy refusal it is retried like; null for anything else. */
function droppedConnection(error: unknown): PuterHttpError | null {
  for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (DROPPED_MESSAGE.test(cause.message) || (typeof code === "string" && DROPPED_CODE.test(code))) {
      return new PuterHttpError(503, JSON.stringify({ error: "The connection to the free model service dropped." }), { kind: "busy", retryAfterMs: null });
    }
  }
  return null;
}

/**
 * A refusal of the request as sent (the model takes no tools, or a 4xx other
 * than a rate limit or a timeout: the tool turns were rejected), which a
 * reshaped history or no tools may pass.
 */
function refusedTheRequest(error: PuterHttpError): boolean {
  return error.kind === "no_tools" || (error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408);
}

/** Waits `ms`, ending early when the turn is stopped. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/**
 * Watches one model run for the two ways a turn ends badly: calling the same
 * tool with the same input over and over, and stopping without a word to the
 * person (the "no result" reply).
 */
class RunGuard {
  private counts = new Map<string, number>();
  private nudges = 0;
  continuations = 0;
  readonly stepsDone: string[] = [];

  /** An error to return instead of running a call that is going in circles; null to run it. */
  repeated(name: string, input: unknown): string | null {
    const key = `${name}:${JSON.stringify(input ?? {})}`;
    const seen = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, seen);
    if (seen <= MAX_IDENTICAL_CALLS) return null;
    return `You already ran ${name} with exactly this input ${seen - 1} times. Running it again will not change the result: use what you have, change the input, or try a different approach.`;
  }

  noteStep(step: StudioAssistantStep) {
    if (step.tool !== "say" && step.tool !== "think") this.stepsDone.push(step.summary);
    // After a change, the same read or test run is a new check, not a repeat; the same change made again still is.
    if (step.ok && CHANGING_TOOLS.has(step.tool)) {
      for (const key of this.counts.keys()) if (!CHANGING_TOOLS.has(key.slice(0, key.indexOf(":")))) this.counts.delete(key);
    }
  }

  /** On a reply with no tool calls and no words: the message that asks for the rest, or null when it may end. */
  silentFinish(): string | null {
    if (this.nudges >= MAX_SILENT_FINISH_NUDGES) return null;
    this.nudges += 1;
    return SILENT_FINISH_PROMPT;
  }

  /** What to tell the person when the model still said nothing: the steps it took. */
  summary(): string {
    if (!this.stepsDone.length) return "I finished without anything to report. Tell me more about what you need and I'll keep going.";
    const shown = this.stepsDone.slice(-12).map((step) => `- ${step}`).join("\n");
    const more = this.stepsDone.length > 12 ? `\n- …and ${this.stepsDone.length - 12} earlier steps` : "";
    return `Here is what I did:\n${shown}${more}\n\nAsk me to continue if anything is unfinished.`;
  }
}
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
    description: "Replace an exact snippet in a file. old_text must appear exactly once (include enough surrounding lines to make it unique), unless replace_all is true, which replaces every occurrence. The result gives an edit_id that undo_edit can reverse.",
    schema: z.object({ path: z.string().min(1), old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() }),
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean", description: "Replace every occurrence" } },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "undo_edit",
    description: "Undo one of the changes made to a file this session, putting back exactly what was there before: by path (the newest change to that file) or by the edit_id a change reported. Use it when a change made things worse. It refuses when the file changed again afterwards; undo the newer change first.",
    schema: z.object({ path: z.string().min(1).optional(), edit_id: z.string().min(1).optional() }).refine((value) => Boolean(value.path || value.edit_id), { message: "Give a path or an edit_id" }),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Undo the newest change to this file" },
        edit_id: { type: "string", description: "Undo this exact change (from a write_file/edit_file/delete_path result)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_files",
    description: "Search the project's text files for a regular expression (case-insensitive) and get matching lines as path:line: text. Use it to find where something is defined or used before editing.",
    schema: z.object({ pattern: z.string().min(1).max(500), path: z.string().optional(), max_results: z.number().int().min(1).max(500).optional() }),
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A regular expression, e.g. function\\s+saveTodo" },
        path: { type: "string", description: "Only search under this folder or file" },
        max_results: { type: "integer", minimum: 1, maximum: 500, description: "Defaults to 100" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "web_search",
    description: "Search the web and get results (title, URL, snippet). Use it for current versions, documentation, APIs, error messages and anything you are not sure of; then read the best results with web_fetch.",
    schema: z.object({ query: z.string().min(1).max(500), count: z.number().int().min(1).max(30).optional() }),
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 30, description: "Defaults to 8" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "web_fetch",
    description: "Open a URL and read it: a page's readable text (mode text, the default) or the raw source of a script, JSON or page (mode raw). Long pages come in pieces: pass offset to continue.",
    schema: z.object({ url: z.string().min(1), mode: z.enum(["text", "raw"]).optional(), offset: z.number().int().min(0).optional() }),
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, mode: { type: "string", enum: ["text", "raw"] }, offset: { type: "integer", minimum: 0 } },
      required: ["url"],
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
  {
    name: "view_app",
    description:
      "See the running app the way the person sees it: Automa opens the page in the person's own App Studio at a phone (390x844) or desktop (1280x800) size, runs its scripts, and reports what is on the screen from top to bottom (headings, text, buttons, inputs, images, with their sizes and positions), console errors and files that failed to load, and layout trouble (sideways scrolling, buttons too small to tap, cut-off text, hard-to-read colors). Start the app first. Use it after you build or change a page, and again after fixing what it found.",
    schema: z.object({ viewport: z.enum(["phone", "desktop"]).optional(), path: z.string().max(500).optional() }),
    parameters: {
      type: "object",
      properties: {
        viewport: { type: "string", enum: ["phone", "desktop"], description: "The screen to look at it on; phone when left out." },
        path: { type: "string", description: "The page in the app, e.g. / or /settings; / when left out." },
      },
      additionalProperties: false,
    },
  },
];

/** A page path in the app: starts with one slash, never leaves the app. */
function appPagePath(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return "/";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return path.split("/").includes("..") ? "/" : path;
}

function clip(text: string, max = MAX_TOOL_OUTPUT) {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters cut off)` : text;
}

/** Like clip, but keeps the end: in a console the newest lines matter most. */
function clipTail(text: string, max = MAX_TOOL_OUTPUT) {
  return text.length > max ? `… (${text.length - max} earlier characters cut off)\n${text.slice(-max)}` : text;
}

/**
 * The lines of one file a search pattern matches, run with a time limit: a
 * pattern that backtracks without end, such as (a+)+$, is stopped instead of
 * freezing the server. Only the start of very long lines (minified code) is
 * searched.
 */
const SCAN_LINES = new vm.Script("found = ((pattern, lines, limit) => { const out = []; for (let i = 0; i < lines.length && out.length < limit; i += 1) if (pattern.test(lines[i].slice(0, 4000))) out.push(i); return out; })(pattern, lines, limit);");
const SCAN_TIMEOUT_MS = 1000;

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
    case "view_app":
      return `Looking at the page on a ${input.viewport === "desktop" ? "desktop" : "phone"}`;
    case "ask_teammate": {
      const who = text(input.teammate, 40);
      return who ? `Asking ${who}` : "Asking a teammate";
    }
    case "run_team": {
      const count = Array.isArray(input.assignments) ? input.assignments.length : 0;
      return count ? `Running a team of ${count}` : "Running the team";
    }
    case "message_team": {
      const who = text(input.to, 40);
      return who ? `Messaging ${who}` : "Messaging the team";
    }
    case "undo_edit":
      return target ? `Undoing the change to ${target}` : "Undoing a change";
    case "search_files": {
      const pattern = text(input.pattern, 50);
      return pattern ? `Searching the files for ${pattern}` : "Searching the files";
    }
    case "web_search": {
      const query = text(input.query, 60);
      return query ? `Searching the web for ${query}` : "Searching the web";
    }
    case "web_fetch": {
      const url = text(input.url, 70);
      return url ? `Reading ${url}` : "Reading a web page";
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

/** Runs a tool; a teammate also gets what the others told it since its last call. */
async function runTool(context: StudioAssistantContext, name: string, rawInput: unknown, signal?: AbortSignal): Promise<ToolOutcome> {
  const outcome = await runToolOnce(context, name, rawInput, signal);
  const news = context.teamChannel?.news() ?? null;
  return news ? { ...outcome, output: `${outcome.output}\n\n${news}` } : outcome;
}

async function runToolOnce(context: StudioAssistantContext, name: string, rawInput: unknown, signal?: AbortSignal): Promise<ToolOutcome> {
  const def = toolsFor(context).find((tool) => tool.name === name);
  if (!def) return { ok: false, output: `Unknown tool ${name}`, step: { tool: name, summary: name, ok: false, detail: "Unknown tool" } };
  const parsed = def.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const message = `Invalid input for ${name}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
    return { ok: false, output: message, step: { tool: name, summary: name, ok: false, detail: message } };
  }
  const input = parsed.data as Record<string, unknown>;
  const actor = context.actor ?? "assistant";
  if (name === "message_team") {
    if (!context.teamChannel) return { ok: false, output: "There is no team chat here.", step: { tool: name, summary: "message_team", ok: false, detail: "No team" } };
    const message = String(input.message);
    const sent = context.teamChannel.post(typeof input.to === "string" ? input.to : undefined, message);
    return { ok: true, output: sent.output, step: { tool: name, summary: sent.summary, ok: true, detail: clip(message, 600) } };
  }
  if (name === "run_team") {
    const members = context.team?.members ?? [];
    if (!context.team || !members.length) {
      return { ok: false, output: "There is no team this turn.", step: { tool: name, summary: "run_team", ok: false, detail: "No teammates" } };
    }
    const assignments = (input.assignments as Array<{ teammate: string; role: string; task: string }>) ?? [];
    const team = context.team;
    const chatStart = team.chatLength();
    const results = await Promise.all(assignments.map(async (assignment) => {
      const member = pickTeammate(members, assignment.teammate);
      if (!member) return { assignment, who: assignment.teammate, ok: false, report: `No such teammate "${assignment.teammate}".` };
      const who = modelLabel(member.model);
      try {
        const report = await team.delegate(member, assignment.task, signal ?? new AbortController().signal, { role: assignment.role });
        return { assignment, who, ok: true, report };
      } catch (error) {
        return { assignment, who, ok: false, report: `Could not finish: ${error instanceof Error ? error.message : String(error)}` };
      }
    }));
    const done = results.filter((result) => result.ok).length;
    const talk = team.talkSince(chatStart);
    const output = `${results.length} teammate${results.length === 1 ? "" : "s"} finished (${done} done, ${results.length - done} failed). Review their changes, test the whole app, and fix what does not fit together.\n\n`
      + results.map((result, index) => `## ${index + 1}. ${result.who} — ${result.assignment.role} — ${result.ok ? "done" : "failed"}\n${clip(result.report, 8000)}`).join("\n\n")
      + (talk ? `\n\n${clip(talk, 12_000)}` : "");
    return {
      ok: done > 0,
      output,
      step: {
        tool: name,
        summary: `Team of ${results.length} finished: ${done} done${results.length - done ? `, ${results.length - done} failed` : ""}`,
        ok: done === results.length,
        detail: results.map((result) => `${result.ok ? "✓" : "✗"} ${result.who} (${result.assignment.role})`).join("\n"),
      },
    };
  }
  if (name === "ask_teammate") {
    const members = context.team?.members ?? [];
    const member = pickTeammate(members, String(input.teammate ?? ""));
    if (!member || !context.team) {
      const message = `No such teammate. Teammates: ${members.map((m, i) => `${i + 1}. ${m.model}`).join("; ") || "(none)"}`;
      return { ok: false, output: message, step: { tool: name, summary: "ask_teammate", ok: false, detail: message } };
    }
    const task = String(input.task ?? "");
    const who = modelLabel(member.model);
    const chatStart = context.team.chatLength();
    try {
      const report = await context.team.delegate(member, task, signal ?? new AbortController().signal);
      const talk = context.team.talkSince(chatStart);
      return { ok: true, output: `${who} reports:\n\n${clip(report, 12_000)}${talk ? `\n\n${clip(talk, 6000)}` : ""}`, step: { tool: name, summary: `${who} reported back`, ok: true, detail: clip(report, 4000) } };
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
        const before = await currentText(context.companyId, context.workspaceId, String(input.path));
        const written = await writeStudioFile(dirs.files, String(input.path), String(input.content));
        await context.onFileChanged(written.path);
        const editId = await recordEdit(context.companyId, context.workspaceId, { path: written.path, before, after: { exists: true, text: String(input.content) }, by: actor }).catch(() => null);
        const verb = before.exists ? "Rewrote" : "Created";
        return {
          ok: true,
          output: `${verb} ${written.path} (${written.size} bytes).${editId ? ` edit_id: ${editId}` : ""}`,
          step: { tool: name, summary: `${verb} ${written.path}`, ok: true, detail: null, path: written.path, ...(editId ? { editId } : {}) },
        };
      }
      case "edit_file": {
        const file = await readStudioFile(dirs.files, String(input.path));
        if (file.content === null) throw new Error("That file is not text");
        const oldText = String(input.old_text);
        const count = file.content.split(oldText).length - 1;
        if (count === 0) throw new Error("old_text was not found in the file; read the file (or search_files) and try again with an exact snippet");
        if (count > 1 && input.replace_all !== true) throw new Error(`old_text appears ${count} times; include more surrounding lines so it is unique, or set replace_all`);
        const next = input.replace_all === true
          ? file.content.split(oldText).join(String(input.new_text))
          : file.content.replace(oldText, () => String(input.new_text));
        const written = await writeStudioFile(dirs.files, file.path, next);
        await context.onFileChanged(written.path);
        const editId = await recordEdit(context.companyId, context.workspaceId, { path: written.path, before: { exists: true, text: file.content }, after: { exists: true, text: next }, by: actor }).catch(() => null);
        const where = input.replace_all === true && count > 1 ? ` (${count} places)` : "";
        return {
          ok: true,
          output: `Edited ${written.path}${where}.${editId ? ` edit_id: ${editId}` : ""}`,
          step: { tool: name, summary: `Edited ${written.path}${where}`, ok: true, detail: null, path: written.path, ...(editId ? { editId } : {}) },
        };
      }
      case "delete_path": {
        const before = await currentText(context.companyId, context.workspaceId, String(input.path));
        await deleteStudioEntry(dirs.files, String(input.path));
        await context.onFileChanged(String(input.path));
        const editId = before.exists && before.text !== null
          ? await recordEdit(context.companyId, context.workspaceId, { path: String(input.path), before, after: { exists: false, text: null }, by: actor }).catch(() => null)
          : null;
        return {
          ok: true,
          output: `Deleted ${input.path}.${editId ? ` edit_id: ${editId}` : ""}`,
          step: { tool: name, summary: `Deleted ${input.path}`, ok: true, detail: null, path: String(input.path), ...(editId ? { editId } : {}) },
        };
      }
      case "undo_edit": {
        const result = await undoEdit(context.companyId, context.workspaceId, { id: typeof input.edit_id === "string" ? input.edit_id : undefined, path: typeof input.path === "string" ? input.path : undefined }, actor);
        await context.onFileChanged(result.undone.path);
        const what = result.undone.beforeExists ? (result.undone.afterExists ? "put back the earlier version" : "restored the deleted file") : "removed the file it had created";
        return {
          ok: true,
          output: `Undid the change to ${result.undone.path} (${what}).${result.undo.id ? ` This undo is edit_id ${result.undo.id}.` : ""}`,
          step: { tool: name, summary: `Undid the change to ${result.undone.path}`, ok: true, detail: null, ...(result.undo.id ? { editId: result.undo.id } : {}) },
        };
      }
      case "search_files": {
        let pattern: RegExp;
        try {
          pattern = new RegExp(String(input.pattern), "i");
        } catch {
          throw new Error("That pattern is not a valid regular expression");
        }
        const limit = Number(input.max_results) || 100;
        const under = typeof input.path === "string" && input.path.trim() ? input.path.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "") : "";
        const files = (await listFilePaths(dirs.files, 5000)).filter((file) => !under || file === under || file.startsWith(`${under}/`));
        const matches: string[] = [];
        let scanned = 0;
        const sandbox = vm.createContext({ pattern, lines: [] as string[], limit: 0, found: [] as number[] });
        for (const file of files) {
          if (matches.length >= limit) break;
          const content = await readStudioFile(dirs.files, file).then((entry) => entry.content).catch(() => null);
          if (content === null) continue;
          scanned += 1;
          const lines = content.split("\n");
          Object.assign(sandbox, { lines, limit: limit - matches.length });
          try {
            SCAN_LINES.runInContext(sandbox, { timeout: SCAN_TIMEOUT_MS });
          } catch {
            throw new Error("That pattern takes too long to run (it backtracks without end, like (a+)+); search with a simpler one");
          }
          for (const index of sandbox.found as number[]) matches.push(`${file}:${index + 1}: ${lines[index]!.trim().slice(0, 240)}`);
        }
        return {
          ok: true,
          output: matches.length ? `${matches.length}${matches.length >= limit ? "+" : ""} matches in ${scanned} files:\n${matches.join("\n")}` : `No matches in ${scanned} files.`,
          step: { tool: name, summary: `Searched the files for ${String(input.pattern).slice(0, 60)}: ${matches.length} match${matches.length === 1 ? "" : "es"}`, ok: true, detail: null },
        };
      }
      case "web_search": {
        const results = await webSearch(String(input.query), Number(input.count) || 8, signal);
        const output = results.length
          ? `${results.length} results:\n\n${results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`).join("\n\n")}`
          : "No results. Try different words.";
        return { ok: true, output, step: { tool: name, summary: `Searched the web for ${String(input.query).slice(0, 80)}`, ok: true, detail: results.slice(0, 5).map((result) => `${result.title} — ${result.url}`).join("\n") || null } };
      }
      case "web_fetch": {
        const offset = Number(input.offset) || 0;
        const page = await webFetch(String(input.url), signal, { mode: input.mode === "raw" ? "raw" : "text", offset });
        const shown = offset + page.text.length;
        const more = page.totalChars > shown ? `\n\n(${page.totalChars - shown} more characters; call again with offset ${shown}.)` : "";
        return {
          ok: true,
          output: clip(`# ${page.title}\n${page.url} · ${page.contentType}\n\n${page.text}${more}`),
          step: { tool: name, summary: `Read ${page.url}`, ok: true, detail: page.title || null },
        };
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
        return { ok: true, output: clipTail(tail) || "(the console is empty)", step: { tool: name, summary: "Read the console", ok: true, detail: null } };
      }
      case "start_app": {
        await context.startApp();
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const state = runtime.state;
        const output = `status: ${state.status}${state.exitCode !== null ? ` (exit code ${state.exitCode})` : ""}\nweb preview ready: ${state.previewReady ? `yes (port ${state.port})` : "no"}\nconsole:\n${clipTail(runtime.consoleTail(80))}`;
        return { ok: state.status !== "failed", output, step: { tool: name, summary: "Started the app", ok: state.status !== "failed", detail: clip(runtime.consoleTail(20), 1200) || null } };
      }
      case "stop_app": {
        await runtime.stop();
        return { ok: true, output: "Stopped.", step: { tool: name, summary: "Stopped the app", ok: true, detail: null } };
      }
      case "view_app": {
        const viewport = input.viewport === "desktop" ? "desktop" : "phone";
        const page = appPagePath(input.path);
        const state = runtime.state;
        if (!state.previewReady || !state.port) {
          return {
            ok: false,
            output: `The app's page is not up${state.status === "running" || state.status === "starting" ? " yet: it has not answered on its port" : ": the app is not running"}. Use start_app (a web app listens on 127.0.0.1:$PORT), then view_app again.`,
            step: { tool: name, summary: "The page is not up yet", ok: false, detail: null },
          };
        }
        const report = await requestPageReport(context.workspaceId, { viewport, path: page });
        if (report) {
          const output = formatPageReport({ ...report, path: page }, viewport);
          return { ok: true, output: clip(output), step: { tool: name, summary: pageReportSummary({ ...report, path: page }, viewport), ok: true, detail: clip(output, 1200) } };
        }
        const output = await staticPageOutline(state.port, page, viewport);
        return { ok: true, output: clip(output), step: { tool: name, summary: `Read ${page} without seeing it (App Studio is closed)`, ok: true, detail: null } };
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
    "How to work: look at the files before changing them (search_files finds where things are); use edit_file for small changes and write_file for new or rewritten files; after changing code, run it (start_app for apps and servers, run_command for scripts and tests) and read the output to confirm it works, then fix what fails. If a change made things worse, undo_edit puts the file back.",
    "Check what the person will see: after you build or change a page, start_app, then view_app (phone first, then desktop) to see it the way they do, with its console errors and layout trouble, and fix what is wrong before you say it is done.",
    "When you need current facts, versions, documentation or an error message explained, use web_search and then web_fetch on the best results; never guess version numbers.",
    "Work until the whole request is done: there is no step or length limit you need to save for. Finish every turn with a short reply to the person.",
    "When the user describes an app in plain words, build all of it: the UI, the logic, and storage (for Node.js, the built-in node:sqlite module needs no install; for Python, sqlite3).",
    language?.kind === "cli"
      ? "This project prints to the console. When the person wants something to look at (a page, a chart, a game, a report, a dashboard), make it a web page anyway: write the page (index.html with its CSS and JavaScript) and have the program serve it on 127.0.0.1:$PORT (for Python, http.server; for Node.js, the http module), then start_app. Automa's preview opens it as soon as it answers."
      : "When the person wants something to look at (a page, a site, a game, a chart, a dashboard, a report), build it as a web page in this project and start_app once it is ready: it opens in Automa's preview, and the person can share it with a public link.",
    "Keep replies short: say what you changed and how to use it. Never print secrets or API keys, and do not touch anything outside the project folder.",
    AUTOMA_ABOUT_FOR_AGENTS,
    ...(context.team?.members.length
      ? [
          `You lead a team of models. Teammates: ${context.team.members.map((m, i) => `${i + 1}. ${modelLabel(m.model)}`).join("; ")}. For bigger jobs, plan first, then use run_team to put several of them to work at once: give each a role (frontend, backend, tests, reviewer…) and a self-contained task naming the files it owns. You wait while they work and get all their reports together; then review their changes, run the app, fix what does not fit, and carry on (run_team again if needed). Use ask_teammate for one quick task. Check their work before you tell the person it is done.`,
        ]
      : []),
  ].join("\n");
}

/** What a teammate is told on top of the project prompt. */
const TEAMMATE_SYSTEM = "You are a teammate model working for the lead on one task in this project. Other teammates may be working on other parts at the same time: change only the files your task is about. Do the task with the tools, test it where you can, and finish with a short written report: what you changed (file paths), what works, what is left or unclear. Do not ask questions; make reasonable choices and say which you made.";

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

/** User messages in a provider history that are the person speaking (not tool results, nor Automa's own "(Automa) …" nudges). */
function spokenUserTurns(messages: Array<{ role: string; content: unknown }>): number {
  return messages.filter((m) => m.role === "user" && (typeof m.content === "string" ? !m.content.startsWith("(Automa)") : (Array.isArray(m.content) && m.content.some((part) => (part as { type?: string }).type === "text" || (part as { type?: string }).type === "image" || (part as { type?: string }).type === "image_url")))).length;
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

/**
 * Marks each step that made a change as undone or not, as the edit log says
 * now (whoever undid it, and an undo can itself be undone, bringing the
 * change back). Returns the turns whose marks changed.
 */
async function syncUndoneSteps(companyId: string, workspaceId: string, turns: StudioAssistantTurn[]): Promise<StudioAssistantTurn[]> {
  const log = new Map((await listEdits(companyId, workspaceId)).map((entry) => [entry.id, entry]));
  return turns.filter((turn) => {
    let changed = false;
    for (const step of turn.steps) {
      const entry = step.editId ? log.get(step.editId) : undefined;
      if (!entry || Boolean(step.undone) === Boolean(entry.undoneBy)) continue;
      if (entry.undoneBy) step.undone = true;
      else delete step.undone;
      changed = true;
    }
    return changed;
  });
}

/**
 * After the person undoes a step: brings the saved steps' undone marks in
 * line with the edit log and returns the turn that holds the step. Other
 * turns whose marks changed (a change an undo brought back) go out here.
 */
export async function markEditUndone(companyId: string, workspaceId: string, editId: string): Promise<StudioAssistantTurn | null> {
  const file = path.join(studioWorkspaceDirs(companyId, workspaceId).meta, "assistant-transcript.json");
  const transcript = await readJson<StudioAssistantTurn[]>(file, []);
  const changed = await syncUndoneSteps(companyId, workspaceId, transcript);
  if (changed.length) await writeJson(file, transcript);
  const turn = transcript.find((candidate) => candidate.steps.some((step) => step.editId === editId)) ?? null;
  for (const other of changed) if (other !== turn) studioHub.broadcast(workspaceId, { type: "assistant", turn: other, done: true });
  return turn;
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
  const copyOfTurn = (): StudioAssistantTurn => ({
    ...turn,
    steps: [...turn.steps],
    ...(turn.agents ? { agents: turn.agents.map((agent) => ({ ...agent, ...(agent.usage ? { usage: { ...agent.usage } } : {}) })) } : {}),
    ...(turn.teamChat ? { teamChat: [...turn.teamChat] } : {}),
    ...(turn.leadUsage ? { leadUsage: { ...turn.leadUsage } } : {}),
  });
  const snapshot = (): StudioAssistantTurn => ({
    ...copyOfTurn(),
    ...(live ? { live: live.trimStart() } : {}),
    ...(liveThinking ? { liveThinking } : {}),
    ...(activity ? { activity } : {}),
  });
  liveTurns.set(context.workspaceId, snapshot);
  let finished = false;
  const publish = (done: boolean) => {
    // A late update (a usage count arriving after the reply ended) must not show it running again.
    if (finished && !done) return;
    studioHub.broadcast(context.workspaceId, {
      type: "assistant",
      turn: done ? copyOfTurn() : snapshot(),
      done,
    });
  };
  studioHub.broadcast(context.workspaceId, { type: "assistant", turn: userTurn, done: true });

  // Every model call in the turn adds up; the turn is recorded once per
  // provider and model that did the work (teammates may use others), so
  // fractions of a cent are not lost to rounding call by call.
  const usageTotals = new Map<string, StudioAiUsage>();
  const onUsage = async (usage: StudioAiUsage) => {
    const model = usage.model || input.model;
    const key = `${usage.provider}:${model}`;
    const total = usageTotals.get(key) ?? { provider: usage.provider, model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
    total.inputTokens += usage.inputTokens;
    total.cachedInputTokens += usage.cachedInputTokens;
    total.outputTokens += usage.outputTokens;
    total.costUsd = usage.costUsd === null || total.costUsd === null ? null : total.costUsd + usage.costUsd;
    usageTotals.set(key, total);
  };
  const worthOf = (usage: StudioAiUsage): number | null => {
    try {
      return context.worthUsd?.(usage) ?? null;
    } catch {
      return null;
    }
  };
  // The lead's own share, live; each teammate's share is kept on its agent.
  const onLeadUsage = (usage: StudioAiUsage) => {
    turn.leadUsage = addTokenUsage(turn.leadUsage, usage, worthOf(usage));
    // The Stats tab counts as it goes, not only when the reply is done.
    publish(false);
    return onUsage(usage);
  };

  const finish = async () => {
    const totals = [...usageTotals.values()].filter((total) => total.inputTokens || total.cachedInputTokens || total.outputTokens);
    if (totals.length) {
      const worths = totals.map((total) => worthOf(total) ?? total.costUsd);
      turn.usage = {
        inputTokens: totals.reduce((sum, total) => sum + total.inputTokens + total.cachedInputTokens, 0),
        outputTokens: totals.reduce((sum, total) => sum + total.outputTokens, 0),
        costUsd: totals.some((total) => total.costUsd === null) ? null : totals.reduce((sum, total) => sum + (total.costUsd ?? 0), 0),
        ...(worths.every((worth) => worth === null) ? {} : { equivalentUsd: worths.reduce<number>((sum, worth) => sum + (worth ?? 0), 0) }),
      };
      for (const total of totals) {
        try {
          await context.onUsage?.(total);
        } catch (error) {
          logger.warn({ error: error instanceof Error ? error.message : String(error), workspaceId: context.workspaceId }, "studio assistant usage not recorded");
        }
      }
    }
    // The reply is saved before the turn stops counting as running, so a
    // reload or a "New chat" in between never sees it missing or revives it.
    transcript.push(turn);
    // A change undone this turn (undo_edit), in this turn or an earlier one, shows as undone.
    const remarked = await syncUndoneSteps(context.companyId, context.workspaceId, transcript).catch(() => [] as StudioAssistantTurn[]);
    try {
      await writeJson(transcriptFile, transcript.slice(-200));
    } catch (error) {
      // A full disk on a phone must not take the whole server down.
      logger.warn({ error: error instanceof Error ? error.message : String(error), workspaceId: context.workspaceId }, "studio assistant transcript not saved");
    }
    running.delete(context.workspaceId);
    liveTurns.delete(context.workspaceId);
    finished = true;
    publish(true);
    for (const other of remarked) if (other !== turn) studioHub.broadcast(context.workspaceId, { type: "assistant", turn: other, done: true });
    try {
      context.onFinished?.(copyOfTurn());
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error), workspaceId: context.workspaceId }, "studio assistant finish hook failed");
    }
  };

  const onStep = (step: StudioAssistantStep) => {
    activity = "";
    turn.steps.push(stamped(step));
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
    turn.steps.push(stamped({ tool: "think", summary: firstLine, ok: true, detail: clip(thought, 6000) }));
    publish(false);
  };
  const onText = (text: string) => {
    live = "";
    if (!text.trim()) return;
    turn.text = turn.text ? `${turn.text}\n\n${text.trim()}` : text.trim();
    // Kept in order with the tool steps, so the chat reads as it happened.
    turn.steps.push(stamped({ tool: "say", summary: text.trim(), ok: true, detail: null }));
    publish(false);
  };

  // Teammates: each runs its task in its own conversation with the same
  // tools, several at once when the lead runs a team. Each shows live on the
  // turn (status, what it is doing, its steps) and stays in the transcript.
  if (input.team?.length) {
    const workingCount = () => (turn.agents ?? []).filter((agent) => agent.status === "working").length;
    turn.teamChat = [];
    const board = new TeamBoard(turn.teamChat, { name: modelLabel(input.model), model: input.model }, () => turn.agents ?? [], () => publish(false));
    context.team = {
      members: input.team,
      chatLength: () => board.messages.length,
      talkSince: (index) => formatTeamTalk(board.talkSince(index)),
      delegate: async (member, task, signal, options) => {
        const who = modelLabel(member.model);
        const role = options?.role?.trim() || null;
        const agent: StudioTeamAgent = {
          id: randomUUID(),
          name: who,
          provider: member.provider,
          model: member.model,
          role,
          task: task.slice(0, 4000),
          status: "working",
          activity: null,
          steps: 0,
          report: null,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        };
        turn.agents = [...(turn.agents ?? []), agent];
        const label = teammateLabel(who, role);
        board.post({ from: STUDIO_TEAM_LEAD_ID, to: agent.id, kind: "task", text: clip(task, 4000) });
        board.join(agent.id);
        const texts: string[] = [];
        const mateContext: StudioAssistantContext = {
          ...context,
          team: undefined,
          actor: label,
          teamChannel: {
            post: (to, message) => {
              if (board.full) return { output: "The team chat is full for this job: put anything else in your final report.", summary: "Team chat full" };
              const target = board.resolve(to, agent.id);
              const sent = board.post({ from: agent.id, to: target.id, kind: "message", text: message });
              const where = sent.toName ?? "everyone";
              return {
                output: `${target.known ? "" : `No teammate is called "${to}", so it went to everyone. `}Sent to ${where}.`,
                summary: `Told ${where}`,
              };
            },
            news: () => formatTeamNews(board.takeUnread(agent.id), agent.id),
          },
        };
        const historyName = `teammate-${agent.id}.json`;
        const overview = await projectOverview(context);
        // Everyone the lead put to work in the same run_team is on the turn by now.
        const crew = (turn.agents ?? []).filter((other) => other.id !== agent.id && other.status === "working").map((other) => teammateLabel(other.name, other.role));
        const common = {
          context: mateContext,
          prompt: [
            `The person asked the lead: ${clip(input.message || "(see the attached files)", 2000)}`,
            role ? `Your role on the team: ${role}` : "",
            task,
            crew.length
              ? `Working on this job at the same time: ${crew.join("; ")}. Use message_team to agree with them on shared file names, APIs, routes and ports, and to say what you finished; what they tell you arrives with your tool results.`
              : "",
            `<project_state>\n${overview}\n</project_state>`,
          ].filter(Boolean).join("\n\n"),
          images: [] as StudioAssistantAttachmentInput[],
          model: member.model,
          credentials: member.credentials,
          signal,
          onStep: (step: StudioAssistantStep) => {
            if (step.tool !== "say" && step.tool !== "think") agent.steps += 1;
            agent.activity = null;
            onStep({ ...step, agent: agent.id, summary: step.tool === "say" || step.tool === "think" ? step.summary : `${label} · ${step.summary}` });
            activity = workingCount() > 1 ? `${workingCount()} teammates working` : "";
          },
          onToolStart: (name: string, rawInput: unknown) => {
            agent.activity = describeActivity(name, rawInput);
            activity = workingCount() > 1 ? `${workingCount()} teammates working` : `${label}: ${agent.activity}`;
            publish(false);
          },
          onText: (text: string) => {
            if (!text.trim()) return;
            texts.push(text);
            turn.steps.push(stamped({ tool: "say", summary: text.trim(), ok: true, detail: null, agent: agent.id }));
            publish(false);
          },
          onDelta: () => undefined,
          onThinkingDelta: () => undefined,
          onThought: (text: string) => {
            const thought = text.trim();
            if (!thought) return;
            const firstLine = thought.split("\n").find((line) => line.trim())?.replace(/^[#*\s]+/, "").slice(0, 140) ?? "Thought";
            turn.steps.push(stamped({ tool: "think", summary: firstLine, ok: true, detail: clip(thought, 6000), agent: agent.id }));
            publish(false);
          },
          onUsage: (usage: StudioAiUsage) => {
            agent.usage = addTokenUsage(agent.usage, usage, worthOf(usage));
            publish(false);
            return onUsage(usage);
          },
          historyName,
          fresh: true,
          systemExtra: `${TEAMMATE_SYSTEM}${role ? ` Your role: ${role}.` : ""}`,
        };
        activity = workingCount() > 1 ? `${workingCount()} teammates working` : `${label} is working`;
        publish(false);
        try {
          if (member.provider === "anthropic") await runAnthropic(common);
          else if (member.provider === "free") await runFreeModels(common);
          else await runOpenAiCompatible({ ...common, provider: member.provider });
          const report = texts.join("\n\n").trim() || "(No report: the teammate finished without writing one.)";
          agent.status = "done";
          agent.report = clip(report, 6000);
          board.post({ from: agent.id, to: STUDIO_TEAM_LEAD_ID, kind: "report", text: clip(report, 4000) });
          return report;
        } catch (error) {
          agent.status = "failed";
          agent.error = error instanceof Error ? error.message : String(error);
          board.post({ from: agent.id, to: STUDIO_TEAM_LEAD_ID, kind: "report", text: `Could not finish: ${agent.error}` });
          throw error;
        } finally {
          agent.activity = null;
          agent.finishedAt = new Date().toISOString();
          activity = workingCount() ? `${workingCount()} teammate${workingCount() === 1 ? "" : "s"} still working` : "";
          publish(false);
          await fs.rm(metaFile(context, historyName), { force: true }).catch(() => undefined);
        }
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
      const common = { ...input, context, prompt, images, signal: controller.signal, onStep, onToolStart, onText, onDelta, onThinkingDelta, onThought, onUsage: onLeadUsage, transcript: earlier };
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
  // Thinking is shown in the panel as it happens (summarized). Earlier turns'
  // thinking stops matching the conversation when its prompt or tools change
  // between turns (a rename, a team added, an image kept only as a note): the
  // API then drops it instead of refusing every later message. Like the
  // streamed tool input, that setting is only sent to Anthropic itself.
  const thinking = supportsAdaptiveThinking(input.model)
    ? ({ type: "adaptive", display: "summarized", ...(baseURL ? {} : { block_binding: { prefix_mismatch_behavior: "drop_block" } }) } as Anthropic.Beta.BetaThinkingConfigParam)
    : null;
  const betas = [...(useFallbacks ? ["server-side-fallback-2026-07-01"] : []), ...(thinking && !baseURL ? ["thinking-binding-controls-2026-08-01"] : [])];
  // High unless the person picked another level the model takes.
  const effort = supportsEffort(input.model) ? thinkingLevelFor("anthropic", input.model, input.thinking) ?? "high" : null;
  let jsonRetries = 0;
  const maxSteps = input.maxSteps ?? MAX_STEPS;
  const guard = new RunGuard();

  for (let step = 0; step < maxSteps; step += 1) {
    if (input.signal.aborted) throw new Error("Stopped.");
    const stream = client.beta.messages.stream(
      {
        model: input.model,
        // Room for long files and long thinking; a reply that still runs out
        // is continued automatically (below), so there is no length ceiling.
        max_tokens: 64000,
        system: [{ type: "text", text: input.systemExtra ? `${systemPrompt(context)}\n\n${input.systemExtra}` : systemPrompt(context), cache_control: { type: "ephemeral" } }],
        tools,
        messages,
        ...(thinking ? { thinking } : {}),
        ...(effort ? { output_config: { effort } } : {}),
        ...(betas.length ? { betas } : {}),
        ...(useFallbacks ? { fallbacks: "default" as const } : {}),
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
      if (guard.continuations < MAX_LENGTH_CONTINUATIONS) {
        guard.continuations += 1;
        // A tool call cut off mid-input cannot run, and an unanswered call
        // would block the conversation: keep the words, drop the call.
        const last = messages[messages.length - 1]!;
        const kept = (last.content as Anthropic.Beta.BetaContentBlockParam[]).filter((block) => block.type !== "tool_use" && block.type !== "server_tool_use");
        last.content = kept.some((block) => block.type === "text") ? kept : [...kept, { type: "text", text: "(cut off by the length limit)" }];
        messages.push({ role: "user", content: CONTINUE_PROMPT });
        await writeJson(historyFile, withoutImages(messages));
        continue;
      }
      input.onText("(My replies kept running into the length limit. Ask me to continue.)");
      return;
    }
    guard.continuations = 0;
    if (response.stop_reason === "pause_turn") continue;
    const toolUses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const said = response.content.some((block) => block.type === "text" && block.text.trim());
      if (!said) {
        const nudge = guard.silentFinish();
        if (nudge) {
          messages.push({ role: "user", content: nudge });
          await writeJson(historyFile, withoutImages(messages));
          continue;
        }
        input.onText(guard.summary());
      }
      return;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (input.signal.aborted) throw new Error("Stopped.");
      input.onToolStart(use.name, use.input);
      const loopNote = guard.repeated(use.name, use.input);
      const outcome = loopNote
        ? { ok: false, output: loopNote, step: { tool: use.name, summary: `${describeActivity(use.name, use.input)} (skipped: same as before)`, ok: false, detail: null } }
        : await runTool(context, use.name, use.input, input.signal);
      guard.noteStep(outcome.step);
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
  const guard = new RunGuard();

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
    const finishReason = data.choices?.[0]?.finish_reason;
    const replyText = typeof message.content === "string" ? message.content : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (finishReason === "length" && guard.continuations < MAX_LENGTH_CONTINUATIONS) {
      // Cut off: keep the words, drop any half-written tool call, and ask for the rest.
      guard.continuations += 1;
      messages.push({ role: "assistant", content: replyText || "(cut off by the length limit)" });
      messages.push({ role: "user", content: CONTINUE_PROMPT });
      await writeJson(historyFile, withoutImages(messages));
      if (replyText) input.onText(replyText);
      continue;
    }
    guard.continuations = 0;
    const assistant: ChatMessage = { role: "assistant", content: message.content ?? "", ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) };
    messages.push(assistant);
    await writeJson(historyFile, withoutImages(messages));
    if (replyText) input.onText(replyText);
    if (!message.tool_calls?.length) {
      if (!replyText.trim()) {
        const nudge = guard.silentFinish();
        if (nudge) {
          messages.push({ role: "user", content: nudge });
          await writeJson(historyFile, withoutImages(messages));
          continue;
        }
        input.onText(guard.summary());
      }
      return;
    }
    for (const call of message.tool_calls) {
      if (input.signal.aborted) throw new Error("Stopped.");
      let args: unknown = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = null;
      }
      if (args !== null) input.onToolStart(call.function.name, args);
      const loopNote = args === null ? null : guard.repeated(call.function.name, args);
      const outcome = args === null
        ? { ok: false, output: "The tool arguments were not valid JSON.", step: { tool: call.function.name, summary: call.function.name, ok: false, detail: "Invalid arguments" } }
        : loopNote
          ? { ok: false, output: loopNote, step: { tool: call.function.name, summary: `${describeActivity(call.function.name, args)} (skipped: same as before)`, ok: false, detail: null } }
          : await runTool(context, call.function.name, args, input.signal);
      guard.noteStep(outcome.step);
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
  const resolved = resolveFreeModel(input.model);
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
  const base = input.systemExtra ? `${systemPrompt(context)}\n\n${input.systemExtra}` : systemPrompt(context);
  // Moan builds apps too: its persona and primer come first, then Studio's own instructions.
  const system = resolved.persona === "moan" ? `${moanSystemPrompt({})}\n\n${base}` : base;
  const maxSteps = input.maxSteps ?? MAX_STEPS;
  // Content Safety takes no tools; asking with them only wastes a request.
  let useTools = puterModelTakesTools(resolved.puterModel);
  const safetyModel = !useTools;
  let textHistory = false;
  let retries = 0;
  const guard = new RunGuard();

  for (let step = 0; step < maxSteps; step += 1) {
    if (input.signal.aborted) throw new Error("Stopped.");
    const history = (textHistory ? toolHistoryAsText(messages as PuterMessage[]) : (messages as PuterMessage[]));
    const sent: PuterMessage[] = [{ role: "system", content: system }, ...history];
    let text = "";
    let reasoning = "";
    const calls: PuterToolCall[] = [];
    let usage: PuterUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason = "end_turn";
    const splitter = createThinkingTagSplitter();
    const emit = (piece: { channel: "text" | "thinking"; text: string }) => {
      if (piece.channel === "thinking") { reasoning += piece.text; input.onThinkingDelta(piece.text); }
      else { text += piece.text; input.onDelta(piece.text); }
    };
    try {
      for await (const event of puterStream(sent, { model: resolved.puterModel, tools: useTools && tools.length ? tools : undefined, signal: input.signal })) {
        if (event.type === "text") for (const piece of splitter.push(event.text)) emit(piece);
        else if (event.type === "reasoning") { reasoning += event.text; input.onThinkingDelta(event.text); }
        else if (event.type === "tool_use") calls.push({ id: event.id, type: "function", function: { name: event.name, arguments: JSON.stringify(event.input ?? {}) } });
        else if (event.type === "done") { usage = event.usage; stopReason = event.stopReason; }
      }
      for (const piece of splitter.flush()) emit(piece);
    } catch (caught) {
      if (input.signal.aborted) throw new Error("Stopped.");
      const error = caught instanceof PuterHttpError ? caught : droppedConnection(caught) ?? caught;
      if (!(error instanceof PuterHttpError)) throw error;
      // A daily limit, a closed or withdrawn model: no retry in this reply fixes it, so say why now.
      if (isLastingPuterError(error)) throw describePuterError(error, label, retries);
      // Only a refusal of the request as sent reshapes it; a busy line, a server error or a dropped connection keeps it.
      if (!textHistory && refusedTheRequest(error) && messages.some((m) => m.role === "tool")) { textHistory = true; step -= 1; continue; }
      if (useTools && refusedTheRequest(error)) { useTools = false; input.onStep({ tool: "say", summary: `(${label} did not take the tools; continuing in text.)`, ok: true, detail: null }); step -= 1; continue; }
      if (retries < FREE_BUSY_RETRIES && isTransientPuterError(error)) { retries += 1; await pause(FREE_RETRY_BASE_MS * retries, input.signal); step -= 1; continue; }
      throw describePuterError(error, label, retries);
    }
    await input.onUsage({ provider: "free", model: input.model, inputTokens: usage.inputTokens, cachedInputTokens: 0, outputTokens: usage.outputTokens, costUsd: 0 });
    // A busy provider counts against this reply only while it stays busy.
    retries = 0;
    // Some models (often behind the Free Router) write a tool call as text
    // instead of calling it: run it all the same rather than show it.
    if (useTools && calls.length === 0 && mayHoldTextToolCalls(text)) {
      const written = parseTextToolCalls(text, tools.map((tool) => tool.function.name));
      if (written.calls.length) {
        text = written.text;
        stopReason = "tool_use";
        for (const call of written.calls) calls.push({ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } });
      }
    }
    if (reasoning.trim()) input.onThought(reasoning);
    const spoken = safetyModel ? formatSafetyVerdict(text.trim()) : text.trim();
    if (spoken) input.onText(spoken);
    if ((stopReason === "max_tokens" || stopReason === "length") && !calls.length && guard.continuations < MAX_LENGTH_CONTINUATIONS) {
      guard.continuations += 1;
      messages.push({ role: "assistant", content: spoken || "(cut off by the length limit)" });
      messages.push({ role: "user", content: CONTINUE_PROMPT });
      await writeJson(historyFile, withoutImages(messages));
      continue;
    }
    guard.continuations = 0;
    const assistant: ChatMessage = {
      role: "assistant",
      content: spoken || (calls.length ? `Calling ${[...new Set(calls.map((call) => call.function.name))].join(", ")}.` : "(no reply)"),
      ...(calls.length ? { tool_calls: calls } : {}),
    };
    messages.push(assistant);
    await writeJson(historyFile, withoutImages(messages));
    if (!calls.length) {
      if (!spoken) {
        const nudge = guard.silentFinish();
        if (nudge) {
          messages.push({ role: "user", content: nudge });
          await writeJson(historyFile, withoutImages(messages));
          continue;
        }
        input.onText(guard.summary());
      }
      return;
    }
    for (const call of calls) {
      if (input.signal.aborted) throw new Error("Stopped.");
      let args: unknown = {};
      try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = null; }
      if (args !== null) input.onToolStart(call.function.name, args);
      const loopNote = args === null ? null : guard.repeated(call.function.name, args);
      const outcome = args === null
        ? { ok: false, output: "The tool arguments were not valid JSON.", step: { tool: call.function.name, summary: call.function.name, ok: false, detail: "Invalid arguments" } }
        : loopNote
          ? { ok: false, output: loopNote, step: { tool: call.function.name, summary: `${describeActivity(call.function.name, args)} (skipped: same as before)`, ok: false, detail: null } }
          : await runTool(context, call.function.name, args, input.signal);
      guard.noteStep(outcome.step);
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
      // As in runAnthropic: never the server's own ANTHROPIC_AUTH_TOKEN.
      authToken: null,
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
  // The editor giving up and the time limit both end a suggestion.
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  if (input.provider === "free") {
    const reply = await puterComplete(
      [{ role: "system", content: COMPLETION_SYSTEM }, { role: "user", content: prompt }],
      { model: resolveFreeModel(input.model).puterModel, retries: 1, signal },
    );
    input.onUsage?.({ provider: "free", model: reply.model, inputTokens: reply.usage.inputTokens, cachedInputTokens: 0, outputTokens: reply.usage.outputTokens, costUsd: 0 });
    return cleanCompletion(reply.text, input.prefix);
  }
  const info = STUDIO_AI_PROVIDER_INFO[input.provider];
  const baseUrl = (input.credentials.baseUrl || info.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Add the API's base URL in Studio's AI settings.");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
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
