import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { pickAnsweringFreeModel, STUDIO_FREE_MODELS } from "@paperclipai/shared";
import { freeModelHealth } from "@paperclipai/shared/puter-ai";
import { queChat, queModelId } from "@paperclipai/shared/que-engine";
import {
  getInspectorProject,
  inspectorAppInfo,
  readInspectorFile,
  searchInspector,
  type InspectorAppInfo,
  type InspectorView,
} from "./inspector.js";

/** The chat's model choice that stands for the person's own Anthropic key. */
export const INSPECTOR_CHAT_CLAUDE = "claude";
/** The longest message a person can send. */
export const INSPECTOR_CHAT_MAX_MESSAGE = 8_000;
const CLAUDE_MODEL = "claude-opus-5-5";
/** Messages kept in the project's folder; older ones drop off. */
const KEPT_MESSAGES = 80;
/** How much of the conversation the model is given again with each question. */
const SENT_MESSAGES = 12;
const SENT_HISTORY_CHARS = 16_000;
/** How much of the open file the model is given. */
const FILE_CHARS = 12_000;
/** A file found by name is shown shorter than the one the person opened. */
const FOUND_FILE_CHARS = 4_000;
const FOUND_NAMES = 2;
const FOUND_PATHS = 8;

export interface InspectorChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  /** Assistant: the model that answered, by id ("claude" for the person's Anthropic key). */
  model?: string;
  /** Person: the file that was open when they asked. */
  path?: string | null;
  view?: InspectorView;
}

/**
 * The free models the chat offers, the most reliable first: App Studio's own
 * list, without a model the Que engine does not serve (asking it is refused).
 */
export const INSPECTOR_CHAT_MODELS: readonly string[] = STUDIO_FREE_MODELS.filter((model) => queModelId(model) !== null);

/** The free model a new chat starts on: the first of the list that is answering now. */
export function inspectorChatDefaultModel(): string {
  return pickAnsweringFreeModel(INSPECTOR_CHAT_MODELS, freeModelHealth()) ?? INSPECTOR_CHAT_MODELS[0]!;
}

/** Thrown when a reply is already being written for this project. */
export class InspectorChatBusyError extends Error {}
/** Thrown when the model could not answer; the message says why, in plain words. */
export class InspectorChatModelError extends Error {}
/** Thrown when the conversation was cleared while its answer was being written; nothing of the question is kept. */
export class InspectorChatClearedError extends Error {}

/** The question being answered for a project, with the means to stop it. */
const asking = new Map<string, AbortController>();

/** A project's saved conversation changes one step at a time: an answer being saved, or a clear. */
const turns = new Map<string, Promise<void>>();

function inTurn<T>(projectId: string, step: () => Promise<T>): Promise<T> {
  const result = (turns.get(projectId) ?? Promise.resolve()).then(step);
  const settled = result.then(() => undefined, () => undefined);
  turns.set(projectId, settled);
  void settled.then(() => {
    if (turns.get(projectId) === settled) turns.delete(projectId);
  });
  return result;
}

function chatFile(dir: string): string {
  return path.join(dir, "chat.json");
}

function projectDir(companyId: string, id: string): string {
  const project = getInspectorProject(companyId, id);
  if (!project) throw new Error("Project not found");
  return project.dir;
}

function isMessage(value: unknown): value is InspectorChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<InspectorChatMessage>;
  return typeof message.id === "string" && (message.role === "user" || message.role === "assistant") && typeof message.text === "string" && typeof message.at === "string";
}

/** The conversation saved with a project, oldest first. A missing or damaged file is an empty conversation. */
export async function readInspectorChat(companyId: string, id: string): Promise<InspectorChatMessage[]> {
  const raw = await fs.readFile(chatFile(projectDir(companyId, id)), "utf8").catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { messages?: unknown };
    return Array.isArray(parsed.messages) ? parsed.messages.filter(isMessage) : [];
  } catch {
    return [];
  }
}

async function writeChat(dir: string, messages: InspectorChatMessage[]): Promise<void> {
  const file = chatFile(dir);
  const next = `${file}.${process.pid}.tmp`;
  await fs.writeFile(next, JSON.stringify({ version: 1, messages: messages.slice(-KEPT_MESSAGES) }, null, 1));
  await fs.rename(next, file);
}

export async function clearInspectorChat(companyId: string, id: string): Promise<void> {
  const dir = projectDir(companyId, id);
  // A question still being answered would save the old conversation back with its answer: stop it.
  asking.get(id)?.abort();
  asking.delete(id);
  await inTurn(id, () => fs.rm(chatFile(dir), { force: true }));
}

function listed(title: string, values: string[], max: number): string {
  if (!values.length) return "";
  const shown = values.slice(0, max).join(", ");
  return `${title} (${values.length}): ${shown}${values.length > max ? ", ..." : ""}\n`;
}

function appSummary(label: string, info: InspectorAppInfo | null): string {
  if (!info) return `App: ${label}\n`;
  return (
    `App: ${info.label ?? label}${info.packageName ? ` (${info.packageName})` : ""}\n` +
    (info.versionName ? `Version: ${info.versionName}${info.versionCode ? ` (code ${info.versionCode})` : ""}\n` : "") +
    (info.minSdk || info.targetSdk ? `Android SDK: min ${info.minSdk ?? "?"}, target ${info.targetSdk ?? "?"}\n` : "") +
    (info.launcherActivity ? `Opens with: ${info.launcherActivity}\n` : "") +
    (info.debuggable ? "Marked debuggable.\n" : "") +
    listed("Permissions", info.permissions, 40) +
    listed("Activities", info.activities, 40) +
    listed("Services", info.services, 20) +
    listed("Receivers", info.receivers, 20) +
    listed("Providers", info.providers, 10)
  );
}

/** Names in a question that could be a class or a file: MainActivity, com.example.Login, strings.xml. */
export function namesIn(message: string): string[] {
  const found: string[] = [];
  for (const match of message.matchAll(/[A-Za-z_][\w$]*(?:[./][A-Za-z_][\w$]*)*/g)) {
    const word = match[0];
    const last = word.split(/[./]/).filter(Boolean).pop() ?? "";
    const base = /^(java|kt|smali|xml|json|yml|yaml|txt|properties)$/i.test(last) ? (word.split(/[./]/).filter(Boolean).at(-2) ?? "") : last;
    if (base.length < 4) continue;
    // A class-like or file-like name: capitals inside, an underscore, or a dotted path.
    if (!/[a-z][A-Z]|_|[./]/.test(word) && !/^[A-Z][a-z]+[A-Z]/.test(word)) continue;
    if (!found.includes(base)) found.push(base);
    if (found.length >= FOUND_NAMES) break;
  }
  return found;
}

async function foundFiles(companyId: string, id: string, view: InspectorView, message: string): Promise<{ paths: string[]; first: { path: string; text: string } | null }> {
  const names = namesIn(message);
  if (!names.length) return { paths: [], first: null };
  const hits = await Promise.all(names.map((name) => searchInspector(companyId, id, view, name, "name").catch(() => ({ results: [], truncated: false }))));
  const paths = [...new Set(hits.flatMap((hit) => hit.results.filter((result) => !result.dir).map((result) => result.path)))].slice(0, FOUND_PATHS);
  if (!paths.length) return { paths, first: null };
  const file = await readInspectorFile(companyId, id, paths[0]!, view).catch(() => null);
  return { paths, first: file && !file.binary ? { path: paths[0]!, text: file.text.slice(0, FOUND_FILE_CHARS) } : null };
}

function viewName(view: InspectorView): string {
  return view === "java" ? "Java decompiled by jadx (for reading)" : "decoded by apktool (smali and resources, editable)";
}

async function instructions(input: { companyId: string; projectId: string; label: string; message: string; path: string | null; view: InspectorView }): Promise<string> {
  const info = await inspectorAppInfo(input.companyId, input.projectId).catch(() => null);
  let text =
    "You are the assistant in Automa's App Inspector. The person decoded an Android app they made or are authorized to analyze, and is reading it on their device. " +
    "Help them understand it: what a file or a class does, where something happens, how the parts fit together, and how to make a change " +
    "(changes are made in the smali or resource files, then Build makes a new APK; the decompiled Java is for reading only). " +
    "Be concrete and brief, and name files by the paths you were shown. You see only what is in this message: the app's summary, the open file if there is one, and files whose names matched the question. " +
    "When you need another file, say which one to open; the person can open it and ask again. Answer in the language the person writes in.\n\n" +
    `## The app\n${appSummary(input.label, info)}`;
  if (input.path) {
    const file = await readInspectorFile(input.companyId, input.projectId, input.path, input.view).catch(() => null);
    if (!file) text += `\n## Open file\n${input.path} could not be read.\n`;
    else if (file.binary) text += `\n## Open file\n${input.path} is a binary file, so its content is not shown.\n`;
    else {
      const cut = file.text.length > FILE_CHARS;
      text += `\n## Open file: ${input.path} (${viewName(input.view)}${cut ? `; the first ${FILE_CHARS.toLocaleString("en-US")} characters` : ""})\n${file.text.slice(0, FILE_CHARS)}\n`;
    }
    return text;
  }
  const found = await foundFiles(input.companyId, input.projectId, input.view, input.message);
  if (found.paths.length) text += `\n## Files whose names match the question (${viewName(input.view)})\n${found.paths.join("\n")}\n`;
  if (found.first) text += `\n## ${found.first.path} (the start of it)\n${found.first.text}\n`;
  return text;
}

/** The newest messages that fit, oldest first, so the model follows the conversation. */
function recent(messages: InspectorChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const kept: Array<{ role: "user" | "assistant"; content: string }> = [];
  let size = 0;
  for (const message of messages.slice(-SENT_MESSAGES).reverse()) {
    size += message.text.length;
    if (size > SENT_HISTORY_CHARS && kept.length) break;
    kept.unshift({ role: message.role, content: message.text });
  }
  // A conversation handed to a model starts with the person.
  while (kept.length && kept[0]!.role !== "user") kept.shift();
  return kept;
}

export interface InspectorChatQuestion {
  companyId: string;
  projectId: string;
  message: string;
  /** The file open in the editor, when the question is about it. */
  path?: string | null;
  view?: InspectorView;
  /** A free model's id, or "claude" for the person's Anthropic key. */
  model: string;
  /** Who asks, for the free models' queue. */
  owner: string;
  anthropicKey?: string | null;
  signal?: AbortSignal;
}

/**
 * One question to the project's chat. The answer comes from exactly the model
 * asked for (a free model is never swapped for another); when that model can't
 * answer, nothing is saved and the error says why, so the person can ask again
 * or pick another model.
 */
export async function askInspectorChat(input: InspectorChatQuestion): Promise<{ reply: InspectorChatMessage; messages: InspectorChatMessage[] }> {
  const project = getInspectorProject(input.companyId, input.projectId);
  if (!project) throw new Error("Project not found");
  const view: InspectorView = input.view ?? "files";
  const useClaude = input.model === INSPECTOR_CHAT_CLAUDE;
  const freeModel = useClaude ? null : queModelId(input.model);
  if (!useClaude && !freeModel) throw new Error(`"${input.model}" is not a model this chat can ask.`);
  if (useClaude && !input.anthropicKey) throw new Error("Add an Anthropic API key on the API keys page to ask Claude here, or pick a free model.");
  if (asking.has(project.id)) throw new InspectorChatBusyError("A reply is still being written here. Wait for it, then ask again.");
  // Stopped by a clear of this conversation, as well as by the person going away.
  const cleared = new AbortController();
  asking.set(project.id, cleared);
  const signal = input.signal ? AbortSignal.any([input.signal, cleared.signal]) : cleared.signal;
  const dropped = () => new InspectorChatClearedError("This conversation was cleared before the answer arrived, so the answer was not kept.");
  try {
    const history = await readInspectorChat(input.companyId, input.projectId);
    const system = await instructions({ companyId: input.companyId, projectId: input.projectId, label: project.label, message: input.message, path: input.path ?? null, view });
    const conversation = [...recent(history), { role: "user" as const, content: input.message }];
    let text: string;
    let answeredBy: string;
    try {
      if (useClaude) {
        const client = new Anthropic({ apiKey: input.anthropicKey!, authToken: null, maxRetries: 2 });
        const message = await client.messages.create({ model: CLAUDE_MODEL, max_tokens: 4096, system, messages: conversation }, { signal });
        text = message.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n").trim();
        answeredBy = INSPECTOR_CHAT_CLAUDE;
      } else {
        const answer = await queChat([{ role: "system", content: system }, ...conversation], {
          scope: input.companyId,
          owner: input.owner,
          model: freeModel!,
          // A question about a file is asked of the file as it is now, by the model the person picked.
          cache: false,
          fallback: false,
          signal,
        });
        // A model that only thinks aloud still answered: its reasoning is the reply, as in Que's own conversations.
        text = answer.text.trim() || answer.reasoning.trim();
        answeredBy = answer.model;
      }
    } catch (error) {
      if (cleared.signal.aborted) throw dropped();
      throw new InspectorChatModelError(error instanceof Error ? error.message : String(error));
    }
    if (cleared.signal.aborted) throw dropped();
    if (!text) throw new InspectorChatModelError("The model sent an empty answer. Ask again, or pick another model.");
    const now = new Date();
    const question: InspectorChatMessage = { id: randomUUID(), role: "user", text: input.message, at: now.toISOString(), path: input.path ?? null, ...(input.path ? { view } : {}) };
    const reply: InspectorChatMessage = { id: randomUUID(), role: "assistant", text, at: new Date(now.getTime() + 1).toISOString(), model: answeredBy };
    const messages = await inTurn(project.id, async () => {
      if (cleared.signal.aborted) throw dropped();
      // The project may have been deleted while the model wrote.
      if (!getInspectorProject(input.companyId, input.projectId)) throw new Error("Project not found");
      // Added to what is saved now, not to what was read before the model wrote: that may have changed since.
      const saved = await readInspectorChat(input.companyId, input.projectId);
      const next = [...saved, question, reply].slice(-KEPT_MESSAGES);
      await writeChat(project.dir, next);
      return next;
    });
    // Cleared while it was being saved: the clear removes it next.
    if (cleared.signal.aborted) throw dropped();
    return { reply, messages };
  } finally {
    // A clear already let the next question in; that one's entry is not this one's to remove.
    if (asking.get(project.id) === cleared) asking.delete(project.id);
  }
}

/** Forgets replies in progress (tests). */
export function __resetInspectorChat(): void {
  asking.clear();
  turns.clear();
}
