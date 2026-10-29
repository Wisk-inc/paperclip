import fs from "node:fs/promises";
import path from "node:path";
import {
  describePuterError,
  formatSafetyVerdict,
  isLastingPuterError,
  isPuterImageModel,
  isTransientPuterError,
  mayHoldTextToolCalls,
  parseTextToolCalls,
  puterModelTakesTools,
  toolHistoryAsText,
  puterComplete,
  puterImage,
  puterStream,
  PUTER_IMAGE_MODELS,
  PUTER_MODELS,
  PUTER_MODEL_META,
  PuterHttpError,
  type PuterContentPart,
  type PuterImageModelId,
  type PuterMessage,
  type PuterModelKey,
  type PuterToolCall,
  type PuterUsage,
} from "@paperclipai/shared/puter-ai";
import { AUTOMA_ABOUT_FOR_AGENTS, isMoanModel, MOAN_LABEL, moanSystemPrompt, pairedFreeImageModel, resolveFreeModel, type FreeModelRunUsage } from "@paperclipai/shared";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asNumber, asString, buildPaperclipEnv } from "../utils.js";
import { equivalentImageCostUsd, equivalentTokenCostUsd } from "../../services/free-models.js";
import { createThinkingTagSplitter, readThinkingLevel, splitThinking, thinkingInstruction } from "./thinking.js";
import { freeToolDefinitions, runFreeTool, type FreeToolContext, type FreeToolToggles, type SavedDocument } from "./tools.js";
import { attachmentName, drawAndUploadImage, listAttachments, loadThread, postReply, readCommentPictures, threadApi, uploadFile, type ThreadApi } from "./thread.js";
import { freeDirectToolRuntime } from "./direct-runtime.js";

const VISION_MODEL = PUTER_MODELS["nemotron-vision"];
const DEFAULT_MAX_TOOL_TURNS = 40;
/** Same-model retries for a busy provider, and how long to wait between them (short under test). */
const MAX_TRANSIENT_RETRIES = 4;
const RETRY_BASE_MS = process.env.VITEST ? 10 : 2500;
/** The same tool call with the same arguments past this many times is a loop, not research. */
const MAX_IDENTICAL_CALLS = 2;
/** Replies with no words and no tool call that are asked again before the run gives up on one. */
const MAX_EMPTY_REPLIES = 2;
const EMPTY_REPLY_NUDGE = "(Automa) Your last reply came back empty. Reply to the person now, in words, with what you have.";

/** The model's display name for status lines and errors. */
export function modelLabel(model: string): string {
  if (isMoanModel(model)) return MOAN_LABEL;
  const key = (Object.keys(PUTER_MODELS) as PuterModelKey[]).find((k) => PUTER_MODELS[k] === model);
  return key ? PUTER_MODEL_META[key].label : model;
}

/** The tool exchanges rewritten as plain text (kept here for the engine's callers and tests). */
export { toolHistoryAsText };

const DROPPED_MESSAGE = /^(?:fetch failed|terminated)$|socket hang up|other side closed|ECONNRESET/i;
const DROPPED_CODE = /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/;

/** A connection that dropped or never opened (common on a phone), as the busy refusal it is retried like; null for anything else. */
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
 * A refusal of the request as sent (a 4xx other than a rate limit or a timeout:
 * the model takes no tools, or the history's tool turns were rejected), which
 * a reshaped history or no tools may pass. A busy line, a server error or a
 * dropped connection is a wait instead, and keeps the request as it is.
 */
function refusedTheRequest(error: PuterHttpError): boolean {
  return error.kind === "no_tools" || (error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408);
}

/** Waits `ms`, ending early when the run is cancelled. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boolToggle(value: unknown, fallback: boolean): boolean {
  if (value === false || value === "off" || value === "false" || value === "none") return false;
  if (value === true || value === "on" || value === "true") return true;
  return fallback;
}

/** The paired image model for a chat model: the chosen one, the default when none is chosen, none when switched off. */
function bondedImageModel(config: Record<string, unknown>): PuterImageModelId | null {
  const raw = pairedFreeImageModel(config);
  if (!raw) return null;
  if (Object.hasOwn(PUTER_IMAGE_MODELS, raw)) return PUTER_IMAGE_MODELS[raw as keyof typeof PUTER_IMAGE_MODELS];
  return isPuterImageModel(raw) ? raw : null;
}

function readToggles(config: Record<string, unknown>, imageModel: PuterImageModelId | null): FreeToolToggles {
  return {
    filesAndCommands: boolToggle(config.freeFiles, true),
    teammatesAndTasks: boolToggle(config.freeTeammates, true),
    web: boolToggle(config.freeWeb, true),
    connections: boolToggle(config.freeConnections, true),
    imageModel,
  };
}

interface Profile {
  role: string;
  title: string;
  teammates: string[];
  /** Every agent's name by id, to say who wrote a teammate's comment. */
  agentNames: Record<string, string>;
  personName: string;
  /** Lookups that failed, for the run log; never shown to the person. */
  notes: string[];
}

/** Who the agent is and who it works with, read as the agent; anything that fails is simply left out. */
async function loadProfile(api: ThreadApi, companyId: string, agentId: string, personId: string | null): Promise<Profile> {
  const profile: Profile = { role: "", title: "", teammates: [], agentNames: {}, personName: "", notes: [] };
  try {
    const me = await api.json<{ role?: string; title?: string | null }>("/api/agents/me");
    profile.role = typeof me.role === "string" ? me.role : "";
    profile.title = typeof me.title === "string" ? me.title : "";
  } catch (error) { profile.notes.push(error instanceof Error ? error.message : String(error)); }
  try {
    const agents = await api.json<Array<{ id: string; name: string; role?: string; title?: string | null; status?: string }>>(`/api/companies/${companyId}/agents`);
    profile.teammates = agents
      .filter((agent) => agent.id !== agentId && agent.status !== "terminated")
      .slice(0, 20)
      .map((agent) => `${agent.name}${agent.title ? ` (${agent.title})` : agent.role ? ` (${agent.role})` : ""}`);
    for (const agent of agents) profile.agentNames[agent.id] = agent.name;
  } catch (error) { profile.notes.push(error instanceof Error ? error.message : String(error)); }
  if (personId) {
    try {
      // The user directory is readable by the company's own agents; the members list is not.
      const directory = await api.json<{ users?: Array<{ principalId: string; user?: { name?: string | null } | null }> }>(`/api/companies/${companyId}/user-directory`);
      const person = directory.users?.find((entry) => entry.principalId === personId);
      profile.personName = (person?.user?.name ?? "").trim();
    } catch (error) { profile.notes.push(error instanceof Error ? error.message : String(error)); }
  }
  return profile;
}

function logLine(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

interface TurnTotals {
  model: string;
  input: number;
  output: number;
}

function sumUsage(spent: TurnTotals[]): PuterUsage {
  return {
    inputTokens: spent.reduce((total, part) => total + part.input, 0),
    outputTokens: spent.reduce((total, part) => total + part.output, 0),
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { agent, config, context, runId, authToken, onLog } = ctx;
  const model = asString(config.model, PUTER_MODELS["deepseek-flash"]);
  // Moan is Nemotron 3 Ultra under a Jamaican persona; everything else is itself.
  const resolved = resolveFreeModel(model);
  const issueId = readId(context.issueId) ?? readId(context.taskId);
  ctx.onDispatch?.();

  if (!issueId) {
    await onLog("stdout", "[paperclip] No conversation on this wake; nothing to answer.\n");
    return { exitCode: 0, signal: null, timedOut: false, provider: "free_models", model, costUsd: 0, summary: null };
  }
  if (!authToken) throw new Error("This Automa server has no agent key (PAPERCLIP_AGENT_JWT_SECRET), so the free model cannot post its reply.");

  const apiUrl = buildPaperclipEnv(agent).PAPERCLIP_API_URL;
  const api = threadApi(apiUrl, authToken, runId, ctx.signal);
  const { issue, comments, lastUser } = await loadThread(api, issueId, agent.id);

  const spent: TurnTotals[] = [];
  const addUsage = (usageModel: string, usage: PuterUsage) => spent.push({ model: usageModel, input: usage.inputTokens, output: usage.outputTokens });

  // The chosen model is itself an image model: draw a picture, no chat loop.
  if (isPuterImageModel(model)) {
    await runImageOnly(ctx, api, issue, lastUser, model, issueId, addUsage);
    return finish(ctx, 1, model, spent);
  }

  const imageModel = bondedImageModel(config);
  const toggles = readToggles(config, imageModel);
  const level = readThinkingLevel(config.effort);
  const direct = toggles.filesAndCommands || toggles.teammatesAndTasks ? freeDirectToolRuntime(ctx) : null;

  // Images drawn by the GenerateImage tool during the run, added to the reply.
  const drawn: { markdown: string; attachmentId: string }[] = [];
  // Files made by the document tools, attached to the reply.
  const made: SavedDocument[] = [];
  let slidePictures = 0;
  const toolCtx: FreeToolContext = {
    toggles,
    direct,
    runtimeTools: ctx.runtimeTools,
    signal: ctx.signal,
    generateImage: async (prompt) => {
      await onLog("stdout", logLine({ type: "acpx.status", message: `Drawing with ${imageModel}` }));
      const image = await drawAndUploadImage(api, issue.companyId, issueId, runId, imageModel!, prompt, ctx.signal);
      drawn.push({ markdown: image.markdown, attachmentId: image.attachmentId });
      addUsage(imageModel!, { inputTokens: 0, outputTokens: 0 });
      return { markdown: image.markdown, attachmentId: image.attachmentId };
    },
    drawPicture: imageModel
      ? async (prompt) => {
          await onLog("stdout", logLine({ type: "acpx.status", message: `Drawing a slide picture with ${imageModel}` }));
          const image = await puterImage(prompt, { model: imageModel, signal: ctx.signal });
          slidePictures += 1;
          addUsage(imageModel, { inputTokens: 0, outputTokens: 0 });
          return { bytes: image.bytes, mimeType: image.mimeType };
        }
      : undefined,
    saveDocument: async (name, bytes, mimeType) => {
      await onLog("stdout", logLine({ type: "acpx.status", message: `Attaching ${name}` }));
      const uploaded = await uploadFile(api, issue.companyId, issueId, name, bytes, mimeType);
      const saved: SavedDocument = { ...uploaded };
      // A copy in the working folder only when the agent may use files; the reply carries it either way.
      if (direct && toggles.filesAndCommands) {
        try {
          await fs.mkdir(path.join(direct.cwd, "documents"), { recursive: true });
          await fs.writeFile(path.join(direct.cwd, "documents", name), bytes);
          saved.savedPath = `documents/${name}`;
        } catch (error) {
          await onLog("stdout", `[paperclip] Could not keep ${name} in the working folder: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      made.push(saved);
      return saved;
    },
    readAttachment: async (ref) => {
      const wanted = ref.trim().toLowerCase();
      const attachments = (await listAttachments(api, issueId)).reverse();
      const match = attachments.find((attachment) => attachment.id === ref)
        ?? attachments.find((attachment) => attachmentName(attachment).toLowerCase() === wanted)
        ?? attachments.find((attachment) => attachmentName(attachment).toLowerCase().includes(wanted));
      if (!match) return null;
      const bytes = new Uint8Array(await (await api.request(match.contentPath)).arrayBuffer());
      return { name: attachmentName(match), contentType: match.contentType, bytes };
    },
  };
  const tools = freeToolDefinitions(toolCtx);
  // Files the person attached to their last message, so the model knows to read them.
  let attachedFiles: string[] = [];
  let unseenPictures = 0;
  if (lastUser) {
    try {
      const attached = (await listAttachments(api, issueId)).filter((attachment) => attachment.issueCommentId === lastUser.id);
      attachedFiles = attached.filter((attachment) => !attachment.contentType.startsWith("image/")).map(attachmentName);
      if (model !== VISION_MODEL) unseenPictures = attached.length - attachedFiles.length;
    } catch (error) { await onLog("stdout", `[paperclip] Attachment list skipped: ${error instanceof Error ? error.message : String(error)}\n`); }
  }

  // Only the vision model reads attached photos; other chat models are told they can't.
  const pictures = lastUser && model === VISION_MODEL ? await readCommentPictures(api, issueId, lastUser.id) : [];
  const profile = await loadProfile(api, issue.companyId, agent.id, readId((issue as { conversationUserId?: unknown }).conversationUserId));
  for (const note of profile.notes) await onLog("stdout", `[paperclip] Profile lookup skipped: ${note}\n`);
  await onLog("stdout", `[paperclip] Profile: ${profile.title || profile.role || "no role"}; person ${profile.personName || "unknown"}; ${profile.teammates.length} teammates\n`);
  // Moan's persona, with what the Jamaican knowledge index holds on the question.
  let persona: string | undefined;
  if (resolved.persona === "moan") {
    const question = (lastUser?.body ?? issue.title ?? "").trim();
    const knowledge = await moanKnowledge(api, question, onLog);
    persona = moanSystemPrompt({ agentName: agent.name, ...knowledge });
  }
  const messages = buildMessages({ agentId: agent.id, agentName: agent.name, issue, comments, lastUser, level, pictures, hasTools: tools.length > 0, canDraw: tools.some((tool) => tool.function.name === "GenerateImage"), profile, attachedFiles, unseenPictures, persona });
  if (messages.length <= 1) throw new Error("Nothing to answer: the conversation is empty");

  await onLog("stdout", logLine({ type: "acpx.session", agent: "free-models", mode: model, permissionMode: tools.length ? "free, with tools" : "free", sessionId: runId }));

  const { answer, answeredBy, stopReason, hitTurnLimit } = await runToolLoop({
    ctx, model, puterModel: resolved.puterModel, messages, tools, toolCtx, level, onLog, addUsage,
    maxTurns: Math.max(1, asNumber(config.maxTurnsPerRun, 0) || DEFAULT_MAX_TOOL_TURNS),
  });

  const imageMarkdown = drawn.filter((image) => !answer.includes(image.attachmentId)).map((image) => image.markdown).join("\n\n");
  // Made files the reply does not link itself get a download line each.
  const fileLinks = made.filter((file) => !answer.includes(file.attachmentId)).map((file) => `📎 [${file.name}](${file.downloadPath})`).join("\n");
  const note = hitTurnLimit ? "\n\n(Stopped after the tool-use limit. Ask me to continue.)" : "";
  // Thinking streams into the collapsible panel live, never into the reply.
  const body = [answer, imageMarkdown, fileLinks].filter(Boolean).join("\n\n")
    + (answeredBy !== model ? `\n\n_${model} was busy, so ${answeredBy} answered._` : "")
    + note;

  await postReply(api, issueId, body.trim() || "(No reply came back. Send the message again.)", [...drawn.map((image) => image.attachmentId), ...made.map((file) => file.attachmentId)]);
  await onLog("stdout", logLine({ type: "acpx.result", summary: answer ? "Replied" : stopReason, stopReason, inputTokens: sumUsage(spent).inputTokens, outputTokens: sumUsage(spent).outputTokens, costUsd: 0 }));
  return finish(ctx, drawn.length + slidePictures, answeredBy, spent, body);
}

/** What the Jamaican knowledge index has on the question, from the server's moan service; nothing when it is off or empty. */
async function moanKnowledge(api: ThreadApi, question: string, onLog: AdapterExecutionContext["onLog"]): Promise<{ knowledge?: string; freshness?: string }> {
  try {
    // Cut by code point: half an emoji makes encodeURIComponent throw.
    const result = await api.json<{ context?: string; freshness?: string }>(`/api/free-models/moan/context?q=${encodeURIComponent(Array.from(question).slice(0, 600).join(""))}`);
    return { knowledge: result.context || undefined, freshness: result.freshness || undefined };
  } catch (error) {
    await onLog("stdout", `[paperclip] Moan knowledge skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    return {};
  }
}

interface BuildInput {
  agentId: string;
  agentName: string;
  issue: { title?: string; description?: string | null; conversationAgentId?: string | null };
  comments: Array<{ id: string; authorAgentId: string | null; body: string }>;
  lastUser: { id: string } | null;
  level: ReturnType<typeof readThinkingLevel>;
  pictures: string[];
  hasTools: boolean;
  /** GenerateImage is among the tools: a paired image model is ready. */
  canDraw: boolean;
  profile: Profile;
  /** Non-image files attached to the person's last message. */
  attachedFiles?: string[];
  /** Pictures attached to the person's last message that this model cannot see. */
  unseenPictures?: number;
  /** A wrapper persona's own prompt (Moan), placed before the agent prompt. */
  persona?: string;
}

function systemPrompt(agentName: string, hasTools: boolean, canDraw: boolean, level: ReturnType<typeof readThinkingLevel>, profile: Profile, attachedFiles: string[] = [], persona?: string, unseenPictures = 0): string {
  const who = [profile.title, profile.role].filter(Boolean).join(", ");
  return [
    persona ?? "",
    `You are ${agentName}${who ? ` (${who})` : ""}, an AI agent on the person's team in Automa, chatting with them in the app.${profile.personName ? ` The person you are talking to is ${profile.personName}; use their name naturally.` : ""}`,
    AUTOMA_ABOUT_FOR_AGENTS,
    profile.teammates.length
      ? `Your teammates in this company: ${profile.teammates.join("; ")}. You can message them and hand them tasks through the Automa API.`
      : "",
    hasTools
      ? "You have tools and you use them to get real answers and do real work: read and search the web, read and change files, run commands, call the Automa API as yourself (talk to teammates, create and update tasks, write plans), use the person's connected apps, and draw pictures. Prefer finding the real answer with a tool over guessing. When you say you did something, a tool must actually have done it. Never repeat a tool call with the same arguments: if a result did not help, change the query, open a different page, or answer with what you have."
      : "Answer in text only in this reply.",
    canDraw
      ? "When the person asks for a picture, image, drawing, illustration, logo, poster, wallpaper or photo of something, call GenerateImage with a detailed prompt (subject, style, lighting, composition). Never say you cannot draw, and never describe the picture instead of drawing it. Then say in a line what you drew."
      : "",
    hasTools
      ? "You also make real files. When the person wants a spreadsheet, workbook, budget, tracker or a table to open in Excel or Google Sheets, call CreateSpreadsheet. When they want slides, a deck, a presentation or a pitch, call CreatePresentation. When they want a letter, report, contract, agreement, essay, CV, plan, form or any document file, call CreateDocument with the complete text in Markdown. The file is attached to your reply, so describe it in a line or two instead of pasting its contents. To work from a file (a spreadsheet, document, presentation, PDF or CSV the person attached, a file in your folder, or one at a URL), call ReadDocument first, then answer about it, change it, or recreate it with a Create tool."
      : "",
    attachedFiles.length
      ? `The person attached ${attachedFiles.length === 1 ? "a file" : "files"} to their last message: ${attachedFiles.join(", ")}. Read ${attachedFiles.length === 1 ? "it" : "them"} with ReadDocument (attachment: the file name) before answering about ${attachedFiles.length === 1 ? "it" : "them"}.`
      : "",
    unseenPictures
      ? `The person attached ${unseenPictures === 1 ? "a picture" : `${unseenPictures} pictures`} to their last message, and you cannot see pictures. Say so plainly instead of guessing what ${unseenPictures === 1 ? "it shows" : "they show"}, and tell them ${modelLabel(VISION_MODEL)} in the model switcher can read pictures.`
      : "",
    "Write the way you would to a teammate: answer first, then the detail that matters, in Markdown.",
    level ? thinkingInstruction(level) : "",
  ].filter(Boolean).join("\n\n");
}

function buildMessages(input: BuildInput): PuterMessage[] {
  const messages: PuterMessage[] = [{ role: "system", content: systemPrompt(input.agentName, input.hasTools, input.canDraw, input.level, input.profile, input.attachedFiles, input.persona, input.unseenPictures) }];
  if (!input.issue.conversationAgentId) {
    const task = `Task: ${input.issue.title ?? ""}\n\n${input.issue.description ?? ""}`.trim();
    if (task) messages.push({ role: "user", content: task });
  }
  for (const comment of input.comments) {
    // Only this agent's own comments are its turns; a teammate agent's comment was said to it.
    const role = comment.authorAgentId === input.agentId ? "assistant" : "user";
    const isLast = input.lastUser && comment.id === input.lastUser.id;
    let text = comment.body;
    if (comment.authorAgentId && role === "user") {
      const name = input.profile.agentNames[comment.authorAgentId];
      text = `(From ${name ? `${name}, ` : ""}a teammate agent)\n\n${text}`;
    }
    // Strict providers refuse two user turns in a row: messages sent back to back become one turn.
    const previous = messages[messages.length - 1];
    if (role === "user" && previous?.role === "user" && typeof previous.content === "string") {
      messages.pop();
      text = `${previous.content}\n\n${text}`;
    }
    if (isLast && input.level) text = `${text}\n\n(${thinkingInstruction(input.level)})`;
    if (isLast && input.pictures.length) {
      const parts: PuterContentPart[] = input.pictures.map((url) => ({ type: "image_url", image_url: { url } }));
      parts.push({ type: "text", text });
      messages.push({ role, content: parts });
    } else {
      messages.push({ role, content: text });
    }
  }
  return messages;
}

interface LoopInput {
  ctx: AdapterExecutionContext;
  /** The chosen model id, as shown to people. */
  model: string;
  /** The id the model service is called with (differs for Moan). */
  puterModel: string;
  messages: PuterMessage[];
  tools: ReturnType<typeof freeToolDefinitions>;
  toolCtx: FreeToolContext;
  level: ReturnType<typeof readThinkingLevel>;
  maxTurns: number;
  onLog: AdapterExecutionContext["onLog"];
  addUsage: (model: string, usage: PuterUsage) => void;
}

async function runToolLoop(input: LoopInput): Promise<{ answer: string; thinking: string; answeredBy: string; stopReason: string; hitTurnLimit: boolean }> {
  const { ctx, messages, toolCtx, level, maxTurns, onLog, addUsage, puterModel } = input;
  const model = input.model;
  const label = modelLabel(model);
  // Content Safety takes no tools; asking with them only wastes a request.
  let useTools = input.tools.length > 0 && puterModelTakesTools(puterModel);
  const safetyModel = !puterModelTakesTools(puterModel);
  const answeredBy = model;
  let lastAnswer = "";
  let lastReasoning = "";
  let stopReason = "end_turn";
  // Recovery, always on this model: a refused request gets the tool history as
  // text, then no tools (each once per run); a busy provider, a server error or
  // a dropped connection gets a few waits with the request unchanged.
  let textHistory = false;
  let retries = 0;
  let triedPlain = false;
  let emptyReplies = 0;
  // Identical tool calls, to cut a loop short.
  const callCounts = new Map<string, number>();
  let repeated = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (ctx.signal?.aborted) break;
    let text = "";
    let reasoning = "";
    const calls: PuterToolCall[] = [];
    let usage: PuterUsage = { inputTokens: 0, outputTokens: 0 };
    // Routes <thinking> tags in the text stream to the thinking panel live, so
    // every model's thinking shows in the collapsible panel, never in the reply.
    const splitter = createThinkingTagSplitter();
    let tagged = "";
    const emit = async (piece: { channel: "text" | "thinking"; text: string }) => {
      if (piece.channel === "thinking") { reasoning += piece.text; tagged += piece.text; }
      else text += piece.text;
      await onLog("stdout", logLine({ type: "acpx.text_delta", text: piece.text, ...(piece.channel === "thinking" ? { channel: "thinking" } : {}) }));
    };
    const attempt = textHistory ? toolHistoryAsText(messages) : messages;
    try {
      for await (const event of puterStream(attempt, { model: puterModel, tools: useTools ? input.tools : undefined, signal: ctx.signal })) {
        if (event.type === "text") { for (const piece of splitter.push(event.text)) await emit(piece); }
        else if (event.type === "reasoning") { reasoning += event.text; await onLog("stdout", logLine({ type: "acpx.text_delta", text: event.text, channel: "thinking" })); }
        else if (event.type === "tool_use") calls.push({ id: event.id, type: "function", function: { name: event.name, arguments: JSON.stringify(event.input ?? {}) } });
        else if (event.type === "done") { usage = event.usage; stopReason = event.stopReason; }
      }
      for (const piece of splitter.flush()) await emit(piece);
      // A reply that opened <thinking> and never closed it holds the answer as well: keep it, as splitThinking does.
      if (!text.trim() && calls.length === 0 && splitter.unclosed) text = tagged;
    } catch (caught) {
      if (ctx.signal?.aborted) break;
      const dropped = caught instanceof PuterHttpError ? null : droppedConnection(caught);
      const error = dropped ?? caught;
      if (!(error instanceof PuterHttpError)) throw error;
      const status = `${error.status}${error.code ? ` ${error.code}` : ""}`;
      // A daily limit, a closed or withdrawn model: no retry in this reply fixes it, so say why now.
      if (isLastingPuterError(error)) throw describePuterError(error, label, retries);
      // The provider refused the history with tool turns in it: say the same things as text.
      // (A busy line, a server error or a dropped connection is no refusal: it keeps its native shape.)
      if (!textHistory && refusedTheRequest(error) && messages.some((message) => message.role === "tool")) {
        textHistory = true;
        await onLog("stdout", logLine({ type: "acpx.status", message: `${label} refused the tool history (${status}); sending it as text and trying again.` }));
        turn -= 1;
        continue;
      }
      // Only a refusal of the request takes the tools away; anything busy is a wait.
      if (useTools && refusedTheRequest(error)) {
        useTools = false;
        await onLog("stdout", logLine({ type: "acpx.status", message: `${label} did not take the tools (${status}); answering in text.` }));
        turn -= 1;
        continue;
      }
      if (retries < MAX_TRANSIENT_RETRIES && isTransientPuterError(error)) {
        retries += 1;
        const message = dropped
          ? `The connection to ${label} dropped; retrying in a moment (${retries}/${MAX_TRANSIENT_RETRIES}).`
          : `${label} is busy (${status}); retrying in a moment (${retries}/${MAX_TRANSIENT_RETRIES}).`;
        await onLog("stdout", logLine({ type: "acpx.status", message }));
        await pause(RETRY_BASE_MS * retries, ctx.signal);
        turn -= 1;
        continue;
      }
      // Last resort on the first turn: the same model without streaming.
      if (turn === 1 && !triedPlain) {
        triedPlain = true;
        try {
          const reply = await puterComplete(attempt, { model: puterModel, retries: 1, signal: ctx.signal });
          addUsage(reply.model, reply.usage);
          const split = splitThinking(reply.text, reply.reasoning);
          if (split.thinking) await onLog("stdout", logLine({ type: "acpx.text_delta", text: split.thinking, channel: "thinking" }));
          await onLog("stdout", logLine({ type: "acpx.text_delta", text: split.answer }));
          return { answer: safetyModel ? formatSafetyVerdict(split.answer) : split.answer, thinking: split.thinking, answeredBy, stopReason: "end_turn", hitTurnLimit: false };
        } catch {
          // Reported below, with the streaming refusal.
        }
        if (ctx.signal?.aborted) break;
      }
      if (dropped) throw new Error(`The connection to ${label} kept dropping, so no reply came back. Automa stayed on this model and retried ${retries} time${retries === 1 ? "" : "s"}. Check the connection and send the message again.`);
      throw describePuterError(error, label, retries);
    }

    addUsage(puterModel, usage);
    // A busy provider counts against this run only while it stays busy.
    retries = 0;
    // Some models (often behind the Free Router) write a tool call as text
    // instead of calling it: run it all the same rather than post it. With
    // the tools off it is not run, and still never posted as the answer.
    if (calls.length === 0 && mayHoldTextToolCalls(text)) {
      const written = parseTextToolCalls(text, input.tools.map((tool) => tool.function.name));
      if (written.calls.length) {
        text = written.text;
        if (useTools) {
          stopReason = "tool_use";
          for (const call of written.calls) calls.push({ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } });
        }
      }
    }
    // No words and no tool call (a free route sometimes drops the whole
    // reply): ask the same model again, then once more for words only.
    if (!text.trim() && calls.length === 0 && emptyReplies < MAX_EMPTY_REPLIES) {
      emptyReplies += 1;
      if (emptyReplies === MAX_EMPTY_REPLIES) {
        useTools = false;
        // Strict providers refuse two user turns in a row: join the person's own when it is last.
        const last = messages[messages.length - 1];
        if (last?.role === "user" && typeof last.content === "string") last.content = `${last.content}\n\n${EMPTY_REPLY_NUDGE}`;
        else if (last?.role === "user" && Array.isArray(last.content)) last.content = [...last.content, { type: "text", text: EMPTY_REPLY_NUDGE }];
        else messages.push({ role: "user", content: EMPTY_REPLY_NUDGE });
      }
      await onLog("stdout", logLine({ type: "acpx.status", message: `${label} sent an empty reply; asking again (${emptyReplies}/${MAX_EMPTY_REPLIES}).` }));
      turn -= 1;
      continue;
    }
    // `text` already has its <thinking> tags routed to `reasoning` by the splitter.
    if (text.trim()) lastAnswer = safetyModel ? formatSafetyVerdict(text.trim()) : text.trim();
    if (reasoning.trim()) lastReasoning = reasoning.trim();

    // The calls decide, not the stop reason: some routes send "end_turn" (or no usage line at all) beside a tool call.
    if (calls.length === 0) {
      return { answer: lastAnswer, thinking: lastReasoning, answeredBy, stopReason, hitTurnLimit: false };
    }
    if (turn >= maxTurns) return { answer: lastAnswer, thinking: lastReasoning, answeredBy, stopReason, hitTurnLimit: true };

    // Never an empty assistant message beside a tool call: some providers
    // (Nemotron 3 Ultra among them) reject the whole conversation for it.
    const spoken = text.trim() || `Calling ${[...new Set(calls.map((call) => call.function.name))].join(", ")}.`;
    messages.push({ role: "assistant", content: spoken, tool_calls: calls });
    for (const call of calls) {
      if (ctx.signal?.aborted) break;
      let args: unknown = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      await onLog("stdout", logLine({ type: "acpx.tool_call", name: call.function.name, toolUseId: call.id, input: args }));
      const key = `${call.function.name}:${JSON.stringify(args)}`;
      const seen = (callCounts.get(key) ?? 0) + 1;
      callCounts.set(key, seen);
      const result = seen > MAX_IDENTICAL_CALLS
        ? (repeated += 1, { content: `You already ran ${call.function.name} with exactly these arguments ${seen - 1} times and the result did not change. Do not run it again: use what you have, change the arguments, or answer now.`, isError: true })
        : await runFreeTool(toolCtx, call.function.name, args);
      await onLog("stdout", logLine({ type: "acpx.tool_result", name: call.function.name, toolUseId: call.id, content: result.content.slice(0, 4_000), ...(result.isError ? { isError: true } : {}) }));
      messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
    }
    if (repeated >= 3 && useTools) {
      // Still looping after being told twice: the tools go away and the model
      // writes its answer from what it has.
      useTools = false;
      await onLog("stdout", logLine({ type: "acpx.status", message: "Repeating the same tool calls; asking for the answer now." }));
      messages.push({ role: "user", content: "(Automa) You are repeating the same tool calls. Stop using tools and answer now with what you have." });
    }
  }
  return { answer: lastAnswer, thinking: lastReasoning, answeredBy, stopReason, hitTurnLimit: false };
}

async function runImageOnly(
  ctx: AdapterExecutionContext,
  api: ThreadApi,
  issue: { title?: string; description?: string | null; companyId: string },
  lastUser: { id: string; body: string } | null,
  model: PuterImageModelId,
  issueId: string,
  addUsage: (model: string, usage: PuterUsage) => void,
): Promise<void> {
  const ask = (lastUser?.body ?? issue.description ?? issue.title ?? "").trim();
  const pictures = lastUser ? await readCommentPictures(api, issueId, lastUser.id, 1) : [];
  let prompt = ask;
  if (pictures.length) {
    await ctx.onLog("stdout", logLine({ type: "acpx.status", message: "Reading the attached picture" }));
    const described = await puterComplete([{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: pictures[0]! } },
        { type: "text", text: `Someone attached this picture and asked: "${ask || "recreate it"}". Write one detailed prompt, under 70 words, for an image generator to draw this picture with that change applied, keeping everything else the same. Reply with the prompt only.` },
      ],
    }], { model: VISION_MODEL, signal: ctx.signal });
    addUsage(described.model, described.usage);
    prompt = described.text.replace(/^["'\s]+|["'\s]+$/g, "");
  }
  if (!prompt) throw new Error("Nothing to draw yet. Describe a picture, or attach one with the change you want.");
  await ctx.onLog("stdout", logLine({ type: "acpx.status", message: `Drawing with ${model}` }));
  const image = await drawAndUploadImage(api, issue.companyId, issueId, ctx.runId, model, prompt, ctx.signal);
  const body = pictures.length ? `${image.markdown}\n\n_Redrawn from your picture: ${prompt}_` : image.markdown;
  await postReply(api, issueId, body, [image.attachmentId]);
}

/** Builds the run result after the reply has been posted; never posts itself. */
async function finish(
  ctx: AdapterExecutionContext,
  images: number,
  answeredBy: string,
  spent: TurnTotals[],
  summaryBody = "",
): Promise<AdapterExecutionResult> {
  const usage = sumUsage(spent);
  const tokenCost = (await Promise.all(spent.filter((part) => part.input + part.output > 0).map((part) => equivalentTokenCostUsd(part.model, { inputTokens: part.input, outputTokens: part.output })))).reduce((a, b) => a + b, 0);
  const freeUsage: FreeModelRunUsage = {
    model: answeredBy,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    images,
    equivalentUsd: tokenCost + equivalentImageCostUsd(images),
  };
  await ctx.onLog("stdout", `[paperclip] Replied with ${answeredBy}: ${usage.inputTokens + usage.outputTokens} tokens${images ? `, ${images} image${images === 1 ? "" : "s"}` : ""}, free (≈ $${freeUsage.equivalentUsd.toPrecision(2)} at paid prices)\n`);
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "free_models",
    biller: "free_models",
    model: answeredBy,
    costUsd: 0,
    usage,
    usageBasis: "per_run",
    resultJson: { engine: "free_models", freeUsage },
    summary: summaryBody.slice(0, 280),
  };
}
