import { z } from "zod";
import { cleanPastedApiKey } from "../ai-connections.js";

/** A Studio project: a folder of code on the Automa server, in one language. */
export interface StudioWorkspace {
  id: string;
  companyId: string;
  name: string;
  language: string;
  description: string | null;
  /** The Git repository it was cloned from. */
  sourceUrl: string | null;
  /** This project's own run command, instead of the language's default. */
  runCommand: string | null;
  createdByUserId: string | null;
  /** Share code collaborators join with, while sharing is on. */
  shareCode: string | null;
  shareEnabled: boolean;
  /** When the share code stops working (null: until sharing is turned off). */
  shareExpiresAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudioFileNode {
  name: string;
  /** Path from the project root, with `/` separators. */
  path: string;
  type: "file" | "folder";
  size?: number;
  /** When the file last changed (ISO time). */
  modifiedAt?: string;
  /** A folder whose contents are not listed (dependencies, git, very large or very deep). */
  unlisted?: boolean;
  /** Why the folder isn't listed, for its label. */
  unlistedReason?: "dependencies" | "git" | "large" | "deep";
  children?: StudioFileNode[];
}

export interface StudioFileContent {
  path: string;
  /** UTF-8 text; null for binary or too-large files. */
  content: string | null;
  size: number;
  binary: boolean;
  /** Changes on every save; send it back to avoid overwriting someone else's save. */
  version: string;
}

export type StudioRunStatus = "idle" | "starting" | "running" | "exited" | "failed" | "stopped";

export interface StudioRunState {
  status: StudioRunStatus;
  command: string | null;
  pid: number | null;
  /** The port a web app serves on, once it answers. */
  port: number | null;
  previewReady: boolean;
  /** Where the running app is previewed through Automa (a fresh random path each run). */
  previewPath: string | null;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  /** The public link while a tunnel is open. */
  publicUrl: string | null;
  tunnelStatus: "off" | "starting" | "on" | "failed";
  tunnelError: string | null;
}

export interface StudioConsoleLine {
  seq: number;
  stream: "stdout" | "stderr" | "system" | "command";
  text: string;
  at: string;
}

export interface StudioToolchainStatus {
  languageId: string;
  requires: string | null;
  available: boolean;
  /** The command that installs it on this host (Termux, apt, or brew), when known. */
  installCommand: string | null;
  note: string | null;
  platform: "termux" | "debian" | "mac" | "other";
}

export interface StudioParticipant {
  id: string;
  name: string;
  role: "owner" | "guest";
  color: string;
  /** The file they are looking at. */
  activePath: string | null;
  online: boolean;
}

/** A saved copy of a project's files to go back to. */
export interface StudioCheckpoint {
  id: string;
  label: string;
  /** `manual`: saved by you; `assistant`: before an AI turn; `change`: before accepting a change; `restore`: before going back. */
  kind: "manual" | "assistant" | "change" | "restore";
  by: string;
  fileCount: number;
  bytes: number;
  /** Files left out for being too large. */
  skippedFiles: number;
  createdAt: string;
}

export interface StudioCollaborator {
  id: string;
  workspaceId: string;
  displayName: string;
  color: string;
  status: "active" | "removed";
  lastSeenAt: string | null;
  createdAt: string;
}

export interface StudioChangeFile {
  path: string;
  /** Contents when the collaborator started editing; null for a new file. */
  before: string | null;
  /** Proposed contents; null to delete the file. */
  after: string | null;
}

export type StudioChangeRequestStatus = "open" | "accepted" | "rejected";

export interface StudioChangeRequest {
  id: string;
  workspaceId: string;
  collaboratorId: string | null;
  authorName: string;
  message: string | null;
  files: StudioChangeFile[];
  status: StudioChangeRequestStatus;
  resolvedAt: string | null;
  createdAt: string;
}

export interface StudioMessageAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string | null;
}

export interface StudioMessage {
  id: string;
  workspaceId: string;
  authorType: "owner" | "guest" | "system";
  authorName: string;
  collaboratorId: string | null;
  body: string;
  attachment: StudioMessageAttachment | null;
  createdAt: string;
}

export const STUDIO_AI_PROVIDERS = ["anthropic", "free", "openai", "openrouter", "google", "moonshot", "deepseek", "xai", "groq", "mistral", "custom"] as const;
export type StudioAiProvider = (typeof STUDIO_AI_PROVIDERS)[number];

export interface StudioAiProviderInfo {
  id: StudioAiProvider;
  name: string;
  /** OpenAI-compatible chat completions endpoint base (unused for Anthropic). */
  baseUrl: string | null;
  defaultModel: string;
  /** A fast model for inline code suggestions. */
  completionModel: string;
  /** Suggested models, newest first. */
  models: readonly string[];
  keyUrl: string | null;
}

/** The free chat models Studio offers, the ones that take tools first. */
export const STUDIO_FREE_MODELS = [
  "deepseek/deepseek-v4.1-flash:free",
  "moan/moan-1:free",
  "qwen/qwen3.8-27b:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "thinkingmachines/inkling:free",
  "thinkingmachines/inkling-small:free",
  "cohere/north-mini-code:free",
  "qwen/qwen3.8-27b-abliterated-cyber:free",
  "recursive/flint-v1.0:free",
  "internlm/atria-dawn-preview:free",
  "apodex/apodex-1.1-mini:free",
  "xingchen-agi/xing4.0-29b-a4b:free",
  "liquid/lfm-2.5-2.6b:free",
] as const;

export const STUDIO_AI_PROVIDER_INFO: Readonly<Record<StudioAiProvider, StudioAiProviderInfo>> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude)",
    baseUrl: null,
    defaultModel: "claude-opus-5-5",
    completionModel: "claude-haiku-5-5",
    models: ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"],
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  free: {
    id: "free",
    name: "Free models (no key)",
    baseUrl: null,
    defaultModel: "deepseek/deepseek-v4.1-flash:free",
    completionModel: "deepseek/deepseek-v4.1-flash:free",
    models: STUDIO_FREE_MODELS,
    keyUrl: null,
  },
  openai: {
    id: "openai",
    name: "OpenAI (GPT)",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-6.1-sol",
    completionModel: "gpt-6-luna",
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5"],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter (any model)",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-opus-5.5",
    completionModel: "anthropic/claude-haiku-5.5",
    models: ["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol", "google/gemini-4-argon", "moonshotai/kimi-k3.1-pro", "google/gemini-3.8-flash", "deepseek/deepseek-v4.1-flash", "x-ai/grok-4.7"],
    keyUrl: "https://openrouter.ai/keys",
  },
  google: {
    id: "google",
    name: "Google (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-4-argon",
    completionModel: "gemini-3.8-flash",
    models: ["gemini-4-argon", "gemini-3.8-flash"],
    keyUrl: "https://aistudio.google.com/apikey",
  },
  moonshot: {
    id: "moonshot",
    name: "Kimi (Moonshot AI)",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k3.1-pro",
    completionModel: "kimi-k3.1-pro-highspeed",
    models: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3"],
    keyUrl: "https://platform.kimi.ai",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    completionModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  xai: {
    id: "xai",
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.7",
    completionModel: "grok-4.7",
    models: ["grok-4.7"],
    keyUrl: "https://console.x.ai",
  },
  groq: {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    completionModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile"],
    keyUrl: "https://console.groq.com/keys",
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    completionModel: "codestral-latest",
    models: ["mistral-large-latest", "codestral-latest"],
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  custom: {
    id: "custom",
    name: "Other (OpenAI-compatible)",
    baseUrl: null,
    defaultModel: "",
    completionModel: "",
    models: [],
    keyUrl: null,
  },
};

export interface StudioAiKeyStatus {
  provider: StudioAiProvider;
  connected: boolean;
  last4: string | null;
  baseUrl: string | null;
  updatedAt: string | null;
  /** Where the key comes from: saved in Studio, or the organization's API keys page. */
  source: "studio" | "automa" | null;
}

/** A file sent with a message to the assistant; the transcript keeps its name and size only. */
export interface StudioAssistantAttachment {
  name: string;
  type: string;
  size: number;
}

/** One step the Studio assistant took, as shown in the chat. */
export interface StudioAssistantStep {
  tool: string;
  /** Short description, for example the path or the command. */
  summary: string;
  ok: boolean;
  /** First part of the result (command output, error). */
  detail: string | null;
}

export interface StudioAssistantTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** In order: what the assistant said (tool `say`) and each tool it used. */
  steps: StudioAssistantStep[];
  /** Text still being written (live updates only). */
  live?: string;
  /** What the model is thinking right now, summarized (live updates only). */
  liveThinking?: string;
  /** The step it is taking right now, e.g. "Running npm install" (live updates only). */
  activity?: string;
  /** Tokens and list-price cost of this reply, once it is done. */
  usage?: { inputTokens: number; outputTokens: number; costUsd: number | null };
  /** On your message: the checkpoint saved just before the assistant started. */
  checkpointId?: string | null;
  /** On your message: the files that went with it. */
  attachments?: StudioAssistantAttachment[];
  provider: StudioAiProvider | null;
  model: string | null;
  error: string | null;
  createdAt: string;
}

/** Events the Studio socket sends. */
export type StudioServerEvent =
  | { type: "hello"; you: StudioParticipant; participants: StudioParticipant[] }
  | { type: "presence"; participants: StudioParticipant[] }
  | { type: "file:saved"; path: string; version: string; content: string | null; by: string }
  | { type: "tree:changed" }
  | { type: "draft"; path: string; text: string; by: StudioParticipant }
  | { type: "draft:clear"; path: string; byId: string }
  | { type: "chat"; message: StudioMessage }
  | { type: "change:new"; changeRequest: StudioChangeRequest }
  | { type: "change:resolved"; changeRequest: StudioChangeRequest }
  | { type: "console"; lines: StudioConsoleLine[] }
  | { type: "console:clear" }
  | { type: "run"; state: StudioRunState }
  | { type: "assistant"; turn: StudioAssistantTurn; done: boolean }
  | { type: "assistant:cleared" }
  | { type: "share"; shareEnabled: boolean }
  | { type: "checkpoint:restored"; checkpoint: StudioCheckpoint }
  | { type: "kicked"; reason: string };

/** Events a Studio client sends. */
export type StudioClientEvent =
  | { type: "draft"; path: string; text: string }
  | { type: "draft:clear"; path: string }
  | { type: "focus"; path: string | null }
  | { type: "ping" };

const relativePath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), "Use a path inside the project");

export const createStudioWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  language: z.string().trim().min(1).max(40),
  description: z.string().trim().max(4000).optional().nullable(),
  /** Clone this Git repository instead of using the language's starter. */
  gitUrl: z.string().trim().url().max(2000).optional().nullable(),
});
export type CreateStudioWorkspace = z.infer<typeof createStudioWorkspaceSchema>;

export const updateStudioWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(4000).optional().nullable(),
  /** Empty or null goes back to the language's default. */
  runCommand: z.string().trim().max(4000).optional().nullable(),
});

export const writeStudioFileSchema = z.object({
  path: relativePath,
  content: z.string().max(5_000_000),
  /** The version you edited; a newer save on the server makes this a 409. */
  baseVersion: z.string().max(200).optional().nullable(),
});

export const createStudioEntrySchema = z.object({
  path: relativePath,
  type: z.enum(["file", "folder"]),
});

export const moveStudioEntrySchema = z.object({
  from: relativePath,
  to: relativePath,
});

export const execStudioCommandSchema = z.object({
  command: z.string().trim().min(1).max(4000),
});

export const studioRunSchema = z.object({
  command: z.string().trim().max(4000).optional().nullable(),
});

export const studioConsoleInputSchema = z.object({
  text: z.string().max(10_000),
});

/** Image types the assistant can look at (sent as base64). */
export const STUDIO_ASSISTANT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const STUDIO_ASSISTANT_MAX_ATTACHMENTS = 4;
/** One image, base64 without the data: prefix, kept under the JSON body limit. */
export const STUDIO_ASSISTANT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** One text file, inlined into the prompt. */
export const STUDIO_ASSISTANT_MAX_TEXT_BYTES = 200 * 1024;
export const studioAssistantAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.string().trim().max(120),
  /** Images travel as base64; text files as their text. */
  encoding: z.enum(["base64", "text"]),
  data: z.string().max(3_000_000),
});
export type StudioAssistantAttachmentInput = z.infer<typeof studioAssistantAttachmentSchema>;

/** How long the assistant thinks before it acts. Left out, the model decides. */
export const STUDIO_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type StudioThinkingLevel = (typeof STUDIO_THINKING_LEVELS)[number];

/**
 * The thinking levels a provider's model takes; empty when it has no setting
 * for it. Claude models before 4.6 and the providers whose APIs ignore or
 * refuse an effort setting get none.
 */
export function studioThinkingLevels(provider: StudioAiProvider, model: string): StudioThinkingLevel[] {
  const id = model.trim().toLowerCase();
  if (provider === "anthropic") {
    if (!/^claude-/.test(id) || /^claude-(?:3|haiku-4|sonnet-4-[05]|opus-4-[015])/.test(id)) return [];
    // Extra high arrived with Opus 4.7; the 4.6 models stop at high, then max.
    return /^claude-(?:opus-4-6|sonnet-4-6)/.test(id) ? ["low", "medium", "high", "max"] : [...STUDIO_THINKING_LEVELS];
  }
  if (provider === "openai") return /^(?:gpt-[5-9]|o[1-9])/.test(id) && !id.includes("-chat") ? ["low", "medium", "high"] : [];
  if (provider === "openrouter" || provider === "google") return id ? ["low", "medium", "high"] : [];
  // Free models think through a hidden instruction at the level picked.
  if (provider === "free") return id ? ["low", "medium", "high", "xhigh"] : [];
  return [];
}

/** A model that works for the lead model in Studio: a provider and a model, with its own key. */
export const studioTeammateSchema = z.object({
  provider: z.enum(STUDIO_AI_PROVIDERS),
  model: z.string().trim().min(1).max(200),
});
export type StudioTeammate = z.infer<typeof studioTeammateSchema>;
export const STUDIO_MAX_TEAMMATES = 4;

export const studioAssistantMessageSchema = z
  .object({
    message: z.string().trim().max(20_000),
    provider: z.enum(STUDIO_AI_PROVIDERS),
    model: z.string().trim().min(1).max(200),
    attachments: z.array(studioAssistantAttachmentSchema).max(STUDIO_ASSISTANT_MAX_ATTACHMENTS).optional(),
    thinking: z.enum(STUDIO_THINKING_LEVELS).optional(),
    /** Other models the lead can hand tasks to during this turn. */
    team: z.array(studioTeammateSchema).max(STUDIO_MAX_TEAMMATES).optional(),
  })
  .refine((value) => value.message.length > 0 || (value.attachments?.length ?? 0) > 0, {
    message: "Write a message or attach a file",
    path: ["message"],
  });

export const saveStudioAiKeySchema = z.object({
  provider: z.enum(STUDIO_AI_PROVIDERS),
  apiKey: z.string().transform(cleanPastedApiKey).pipe(z.string().min(8).max(1000)),
  baseUrl: z.string().trim().url().max(500).optional().nullable(),
});

export const createStudioCheckpointSchema = z.object({
  label: z.string().trim().max(160).optional().nullable(),
});

export const shareStudioSchema = z.object({
  /** Also open a public link to the collaborator page (needs cloudflared). */
  public: z.boolean().optional(),
  /** How long the code works: hours from now, or null for until you stop sharing. */
  expiresInHours: z.number().int().min(1).max(24 * 90).optional().nullable(),
  /** Replace the code (people who already joined stay in). */
  newCode: z.boolean().optional(),
});

export const studioCompleteSchema = z.object({
  path: z.string().trim().min(1).max(1024),
  /** Text before the cursor (the end of it). */
  prefix: z.string().max(12_000),
  /** Text after the cursor (the start of it). */
  suffix: z.string().max(4_000),
  provider: z.enum(STUDIO_AI_PROVIDERS),
  model: z.string().trim().max(200).optional().nullable(),
});

export const joinStudioSchema = z.object({
  code: z.string().trim().min(4).max(20),
  name: z.string().trim().min(1).max(40),
});

export const createStudioChangeRequestSchema = z.object({
  message: z.string().trim().max(2000).optional().nullable(),
  files: z
    .array(
      z.object({
        path: relativePath,
        /** Ignored: Automa records the file as it is when the change arrives. */
        before: z.string().max(5_000_000).nullable().optional(),
        after: z.string().max(5_000_000).nullable(),
      }),
    )
    .min(1)
    .max(50),
});

export const resolveStudioChangeRequestSchema = z.object({
  /** The owner's edited version of some files, used instead of the proposal. */
  files: z
    .array(z.object({ path: relativePath, after: z.string().max(5_000_000).nullable() }))
    .max(50)
    .optional(),
});

export const postStudioMessageSchema = z.object({
  body: z.string().trim().max(4000),
});
