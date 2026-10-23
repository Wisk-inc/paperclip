import { promises as fs } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  buildPaperclipEnv,
  normalizePaperclipWakePayload,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  adapterExecutionTargetIsRemote,
  readAdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { estimateClaudeCostUsd } from "@paperclipai/shared";
import { claudeLocalReasoningEffortsForModel, resolveClaudeModel } from "../index.js";

/**
 * The direct API engine: the agent answers through the Anthropic Messages API
 * with the organization's (or agent's) API key, without the Claude Code
 * program. It is what runs on a phone, where Claude Code cannot start (Termux
 * is Android, and the Claude Code binary is built for desktop Linux and
 * macOS), and anywhere the agent is set to `engine: "api"`.
 *
 * It answers conversations and messages people send: the reply streams into
 * the run log as it is written (the chat shows it token by token), thinking
 * streams too (summarized), and the finished reply is posted by the server
 * like any other agent reply. It has no tools, so it never claims to have
 * changed tasks or files.
 */

const DIRECT_ENGINE_NAMES = new Set(["api", "direct", "direct_api", "anthropic_api"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 5;
// The API takes up to 5 MB per image once base64-encoded; 3.75 MB of raw bytes fits.
const MAX_IMAGE_BYTES = 3_750_000;
const MAX_INSTRUCTIONS_CHARS = 60_000;
const MAX_HISTORY_MESSAGES = 40;
/** Live output is sent in small batches so the chat updates smoothly without a log line per token. */
const FLUSH_MS = 100;

export type ClaudeDirectApiReason = "configured" | "phone" | "engine_unavailable";

export interface ClaudeDirectApiCredentials {
  apiKey: string;
  baseUrl: string | null;
}

export function claudeDirectApiCredentials(config: Record<string, unknown>): ClaudeDirectApiCredentials | null {
  const env = parseObject(config.env);
  // A key the agent's own environment names wins, and so does a blank one:
  // the server blanks ANTHROPIC_API_KEY on purpose for subscription logins so
  // the host's own key is never borrowed. Only an agent that says nothing
  // about it uses the key this server was started with.
  const read = (key: string) => {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      return typeof env[key] === "string" ? (env[key] as string).trim() : "";
    }
    return (process.env[key] ?? "").trim();
  };
  const apiKey = read("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
  const baseUrl = read("ANTHROPIC_BASE_URL") || null;
  return { apiKey, baseUrl };
}

/**
 * How to ask a model to think. Claude 4.6 and newer (and every 5.x model)
 * take adaptive thinking and an effort level; older 4.x models and Claude
 * 3.7 Sonnet need a fixed thinking budget and reject effort; earlier models
 * don't think at all. Names this can't read (gateway aliases) are treated as
 * current models.
 */
export function claudeThinkingStyle(model: string): "adaptive" | "budget" | "none" {
  const match = /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/i.exec(model)
    ?? /claude-(\d+)(?:[-.](\d+))?-(?:opus|sonnet|haiku)/i.exec(model);
  if (!match) return "adaptive";
  const major = Number(match[1]);
  // A dated id such as claude-opus-4-20250514 has no minor version.
  const minor = match[2] && match[2].length <= 2 ? Number(match[2]) : 0;
  if (major >= 5 || (major === 4 && minor >= 6)) return "adaptive";
  if (major === 4 || (major === 3 && minor === 7)) return "budget";
  return "none";
}

/** True when the agent is explicitly set to answer through the API. */
export function claudeDirectApiConfigured(config: Record<string, unknown>): boolean {
  const engine = typeof config.engine === "string" ? config.engine.trim().toLowerCase() : "";
  return DIRECT_ENGINE_NAMES.has(engine);
}

/** Node reports "android" inside Termux, where the Claude Code binary cannot run. */
export function runningOnPhone(): boolean {
  return process.platform === "android";
}

/**
 * True when the agent runs on this machine. An agent sent to an SSH host or a
 * sandbox runs Claude Code there, so the phone and "engine missing" fallbacks
 * (which answer from this server with its key) don't apply to it.
 */
export function claudeRunsHere(target: { executionTarget?: unknown; legacyRemoteExecution?: unknown }): boolean {
  return !adapterExecutionTargetIsRemote(
    readAdapterExecutionTarget({
      executionTarget: target.executionTarget as Parameters<typeof readAdapterExecutionTarget>[0]["executionTarget"],
      legacyRemoteExecution: target.legacyRemoteExecution as Parameters<typeof readAdapterExecutionTarget>[0]["legacyRemoteExecution"],
    }),
  );
}

function errorResult(message: string, code: string, spent?: SpentTokens | null): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: code,
    errorMessage: message,
    provider: "anthropic",
    biller: "anthropic",
    summary: message,
    ...(spent ? spentFields(spent) : {}),
  };
}

/** A reply stopped by the person: acknowledged, with whatever it used. */
function stoppedResult(spent: SpentTokens | null): AdapterExecutionResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorCode: "cancelled",
    errorMessage: "Stopped.",
    provider: "anthropic",
    biller: "anthropic",
    summary: null,
    // No tools ran and the chat history is the session, so nothing needs
    // reconciling: the next message simply continues the conversation.
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
    clearSession: true,
    resultJson: {
      engine: "direct_api",
      executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString(), forced: false },
    },
    ...(spent ? spentFields(spent) : {}),
  };
}

/** Tokens a call has used so far, read from the stream as it runs. */
interface SpentTokens {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function spentCostUsd(spent: SpentTokens): number | null {
  return estimateClaudeCostUsd(spent.model, {
    inputTokens: spent.input,
    outputTokens: spent.output,
    cacheReadInputTokens: spent.cacheRead,
    cacheCreationInputTokens: spent.cacheWrite,
  });
}

/**
 * Usage fields for a result. A refused, stopped or cut-off reply is still
 * billed for what it used, so every exit path reports it.
 */
function spentFields(spent: SpentTokens): Partial<AdapterExecutionResult> {
  if (spent.input + spent.output + spent.cacheRead + spent.cacheWrite === 0) return {};
  return {
    billingType: "api",
    usage: {
      inputTokens: spent.input + spent.cacheWrite,
      outputTokens: spent.output,
      cachedInputTokens: spent.cacheRead,
    },
    usageBasis: "per_run",
    costUsd: spentCostUsd(spent),
  };
}

interface ReplayLine {
  author: "agent" | "user";
  body: string;
}

/**
 * The server adds the earlier messages of a chat session to the task context
 * as one JSON object per line, after a fixed heading. They become the
 * conversation history here.
 */
export function readConversationReplay(taskMarkdown: string): ReplayLine[] {
  const marker = "Earlier messages in this session (quoted user data):\n";
  const start = taskMarkdown.indexOf(marker);
  if (start === -1) return [];
  const lines: ReplayLine[] = [];
  for (const raw of taskMarkdown.slice(start + marker.length).split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) {
      if (lines.length > 0) break;
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { author?: unknown; body?: unknown };
      if (typeof parsed.body !== "string" || !parsed.body.trim()) continue;
      lines.push({ author: parsed.author === "agent" ? "agent" : "user", body: parsed.body });
    } catch {
      break;
    }
  }
  return lines;
}

type MessageParam = Anthropic.MessageParam;
type ContentBlock = Anthropic.ContentBlockParam;

/** Consecutive turns from the same side are joined: the API expects user and assistant to alternate. */
export function buildConversationMessages(history: ReplayLine[], current: ContentBlock[]): MessageParam[] {
  const messages: MessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: ContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last && last.role === role) {
      last.content = [...(last.content as ContentBlock[]), ...blocks];
    } else {
      messages.push({ role, content: blocks });
    }
  };
  for (const line of history.slice(-MAX_HISTORY_MESSAGES)) {
    push(line.author === "agent" ? "assistant" : "user", [{ type: "text", text: line.body }]);
  }
  // The history must open with the person, not the agent.
  while (messages[0]?.role === "assistant") messages.shift();
  push("user", current);
  return messages;
}

const ATTACHMENT_PATTERN = /\/api\/attachments\/([0-9a-f-]{36})\/content/gi;

async function readImageAttachments(
  bodies: string[],
  ctx: AdapterExecutionContext,
  onNote: (note: string) => Promise<void>,
): Promise<{ blocks: ContentBlock[]; skipped: string[] }> {
  const allIds = [...new Set(bodies.flatMap((body) => [...body.matchAll(ATTACHMENT_PATTERN)].map((match) => match[1]!)))];
  const ids = allIds.slice(0, MAX_IMAGES);
  const skipped: string[] = [];
  if (allIds.length > MAX_IMAGES) skipped.push(`${allIds.length - MAX_IMAGES} more attachment(s): only ${MAX_IMAGES} images are read per message`);
  if (ids.length === 0 || !ctx.authToken) return { blocks: [], skipped: ids.length ? [`${ids.length} attachment(s): no access to read them`] : skipped };
  const apiUrl = buildPaperclipEnv(ctx.agent).PAPERCLIP_API_URL;
  const blocks: ContentBlock[] = [];
  for (const id of ids) {
    try {
      const response = await fetch(`${apiUrl}/api/attachments/${id}/content`, {
        headers: { authorization: `Bearer ${ctx.authToken}` },
        signal: ctx.signal,
      });
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!response.ok) {
        skipped.push(`an attachment that could not be opened (${response.status})`);
        continue;
      }
      if (!IMAGE_TYPES.has(type)) {
        // PDFs, documents and HEIC photos aren't read by this engine.
        skipped.push(`a ${type || "file"} attachment (only PNG, JPEG, GIF and WebP images are read here)`);
        continue;
      }
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        skipped.push(`an image over ${Math.round(MAX_IMAGE_BYTES / 1_000_000 * 10) / 10} MB`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        skipped.push(bytes.length === 0 ? "an empty image" : `an image over ${Math.round(MAX_IMAGE_BYTES / 1_000_000 * 10) / 10} MB`);
        continue;
      }
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: type as "image/png", data: bytes.toString("base64") },
      });
    } catch {
      skipped.push("an attachment that could not be read");
    }
  }
  if (skipped.length) await onNote(`[paperclip] Not shown to the model: ${skipped.join("; ")}.\n`);
  return { blocks, skipped };
}

async function readInstructions(config: Record<string, unknown>): Promise<string> {
  const file = asString(config.instructionsFilePath, "").trim();
  if (!file) return "";
  try {
    const text = await fs.readFile(file, "utf8");
    return text.length > MAX_INSTRUCTIONS_CHARS ? `${text.slice(0, MAX_INSTRUCTIONS_CHARS)}\n…` : text;
  } catch {
    return "";
  }
}

const MODE_NOTES: Record<string, string> = {
  ask: "The person chose Ask mode: answer questions and explain; do not propose to change anything.",
  planning: "The person chose Plan mode: help them think the work through and write a clear plan with steps, risks and open questions.",
  standard: "",
};

function systemPrompt(input: {
  agentName: string;
  instructions: string;
  workMode: string;
  conversation: boolean;
  issueTitle: string;
}): string {
  return [
    `You are ${input.agentName}, an AI agent on the person's team in Automa.`,
    input.conversation
      ? "You are chatting with them in the Automa app."
      : `They wrote to you on the task "${input.issueTitle}" in the Automa app.`,
    "In this reply you answer in text only: you cannot run tools, edit files, or change tasks, so never say you did. When something needs doing in Automa, say exactly what to do (for example: create a task and assign it, or open App Studio).",
    "Write the way you would talk to a teammate: answer first, then the detail that matters. Use Markdown (short paragraphs, lists, code blocks) when it helps.",
    MODE_NOTES[input.workMode] ?? "",
    input.instructions ? `\nYour instructions from the person who set you up:\n\n${input.instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** One stdout line in the shape the chat already renders live (see acpx-engine/ui). */
function logLine(event: Record<string, unknown>) {
  return `${JSON.stringify(event)}\n`;
}

function describeApiError(error: unknown, aborted: boolean): { message: string; code: string } {
  if (aborted) return { message: "Stopped.", code: "cancelled" };
  if (error instanceof Anthropic.AuthenticationError) {
    return { message: "Anthropic rejected the API key. Check it in Settings → API keys.", code: "claude_api_auth_failed" };
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return { message: "This Anthropic key can't use that model. Pick another model for the agent.", code: "claude_api_permission_denied" };
  }
  if (error instanceof Anthropic.NotFoundError) {
    return { message: "Anthropic doesn't know that model name. Pick another model for the agent.", code: "claude_api_model_not_found" };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { message: "Anthropic is rate limiting this key. Wait a moment and send again.", code: "claude_api_rate_limited" };
  }
  const status = error instanceof Anthropic.APIError ? error.status : undefined;
  const apiType = error instanceof Anthropic.APIError
    ? (error.error as { error?: { type?: string } } | undefined)?.error?.type
    : undefined;
  if (status === 529 || apiType === "overloaded_error") {
    return { message: "Anthropic is overloaded right now. Send the message again in a minute.", code: "claude_transient_upstream" };
  }
  if (error instanceof Anthropic.InternalServerError || (status !== undefined && status >= 500)) {
    return { message: "Anthropic had a server error. Send the message again in a minute.", code: "claude_transient_upstream" };
  }
  if (error instanceof Anthropic.APIError) {
    // The SDK's message repeats the status and the raw JSON body; the API's
    // own sentence is what helps.
    const detail = (error.error as { error?: { message?: string } } | undefined)?.error?.message ?? error.message;
    return { message: `Anthropic refused the request: ${detail}`.replace(/\s+/g, " ").trim(), code: "claude_api_error" };
  }
  return { message: error instanceof Error ? error.message : String(error), code: "claude_api_error" };
}

export async function executeClaudeDirectApi(
  ctx: AdapterExecutionContext,
  reason: ClaudeDirectApiReason,
): Promise<AdapterExecutionResult> {
  const { config, context, onLog } = ctx;
  const credentials = claudeDirectApiCredentials(config);
  if (!credentials) {
    return errorResult(
      reason === "phone"
        ? "Claude Code can't run on a phone, so this agent answers with an Anthropic API key, and none is set. Add one in Settings → API keys, then send your message again."
        : "This agent answers through the Anthropic API and has no API key. Add one in Settings → API keys.",
      "claude_api_key_missing",
    );
  }

  const env = parseObject(config.env);
  const model = resolveClaudeModel(config.model, env) || "claude-opus-5-5";
  const thinkingStyle = claudeThinkingStyle(model);
  const efforts = thinkingStyle === "adaptive" ? claudeLocalReasoningEffortsForModel(model) : [];
  const requestedEffort = asString(config.effort, "").trim().toLowerCase();
  const effort = efforts.includes(requestedEffort) ? requestedEffort : null;
  const conversation = context.conversationMode === true;
  const issue = parseObject(context.paperclipIssue);
  const workMode = asString(issue.workMode, "standard");

  if (context.conversationReset === true) {
    await onLog("stdout", "[paperclip] Started a fresh session.\n");
    return { exitCode: 0, signal: null, timedOut: false, provider: "anthropic", biller: "anthropic", model, summary: null, clearSession: true };
  }

  const wake = normalizePaperclipWakePayload(context.paperclipWake);
  const personComments = (wake?.comments ?? []).filter((comment) => comment.authorType !== "agent" && comment.body.trim());
  const wakeReason = asString(context.wakeReason, "");
  // Scheduled and recovery wakes have nobody to answer; only people's messages
  // (and a task newly assigned to the agent) start a paid call.
  if (personComments.length === 0 && !conversation && wakeReason !== "issue_assigned") {
    await onLog(
      "stdout",
      "[paperclip] Nothing to answer: this agent replies to messages through the Anthropic API, and this wake has none.\n",
    );
    return { exitCode: 0, signal: null, timedOut: false, provider: "anthropic", biller: "anthropic", model, summary: null };
  }

  const history = conversation ? readConversationReplay(asString(context.paperclipTaskMarkdown, "")) : [];
  const bodies = personComments.map((comment) => comment.body);
  const text = bodies.length
    ? bodies.join("\n\n")
    : conversation
      ? "Continue."
      : `You were assigned this task. Reply with how you would approach it.\n\n${asString(context.paperclipTaskMarkdown, "").slice(0, 20_000)}`;
  const images = await readImageAttachments(bodies, ctx, (note) => onLog("stdout", note));
  const promptText = images.skipped.length
    ? `${text}\n\n(Attached but not visible to you: ${images.skipped.join("; ")}. Say so if it matters for your answer.)`
    : text;
  const messages = buildConversationMessages(history, [...images.blocks, { type: "text", text: promptText }]);
  // The whole conversation so far is cached, not only the system prompt:
  // every turn replays the history, and cached input costs a tenth.
  const lastMessage = messages.at(-1);
  const lastBlock = Array.isArray(lastMessage?.content) ? (lastMessage!.content as ContentBlock[]).at(-1) : undefined;
  if (lastBlock && lastBlock.type === "text") (lastBlock as Anthropic.TextBlockParam).cache_control = { type: "ephemeral" };
  const system = systemPrompt({
    agentName: ctx.agent.name,
    instructions: await readInstructions(config),
    workMode,
    conversation,
    issueTitle: asString(issue.title, "this task"),
  });

  const client = new Anthropic({
    apiKey: credentials.apiKey,
    // Without this the SDK adds the server's own ANTHROPIC_AUTH_TOKEN, and
    // whoever set the agent's base URL would receive it.
    authToken: null,
    baseURL: credentials.baseUrl ?? undefined,
    maxRetries: 2,
  });

  await onLog(
    "stdout",
    logLine({
      type: "acpx.session",
      agent: "claude-api",
      mode: model,
      permissionMode: reason === "phone" ? "direct on this phone" : "direct",
      sessionId: ctx.runId,
    }),
  );
  ctx.onDispatch?.();

  // Thinking and reply text arrive as tiny deltas; they go to the log in
  // batches so the chat redraws smoothly instead of once per token.
  let pending: { channel: "thinking" | "text"; text: string } | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let logChain: Promise<void> = Promise.resolve();
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending || !pending.text) return;
    const { channel, text: chunk } = pending;
    pending = null;
    const line = logLine({ type: "acpx.text_delta", text: chunk, ...(channel === "thinking" ? { channel: "thinking" } : {}) });
    logChain = logChain.then(() => onLog("stdout", line)).catch(() => {});
  };
  const queue = (channel: "thinking" | "text", delta: string) => {
    if (!delta) return;
    if (pending && pending.channel !== channel) flush();
    pending = pending ? { channel, text: pending.text + delta } : { channel, text: delta };
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  };

  const startedAt = Date.now();
  const spent: SpentTokens = { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Tells the server Stop works from here on: the request is aborted and the
  // chat carries on, instead of the run being held for manual recovery.
  await ctx.onCancellationReady?.();
  if (ctx.signal?.aborted) return stoppedResult(null);
  try {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: thinkingStyle === "none" ? 8_192 : 32_000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
        // Thinking stays on and is shown: the summarized text streams into
        // the chat's thinking panel. Older models get a fixed budget instead.
        ...(thinkingStyle === "adaptive"
          ? { thinking: { type: "adaptive" as const, display: "summarized" as const } }
          : thinkingStyle === "budget"
            ? { thinking: { type: "enabled" as const, budget_tokens: 10_000 } }
            : {}),
        ...(effort ? { output_config: { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" } } : {}),
      },
      { signal: ctx.signal },
    );
    stream.on("streamEvent", (event) => {
      if (event.type === "message_start") {
        const usage = event.message.usage;
        spent.model = event.message.model || model;
        spent.input = usage.input_tokens ?? 0;
        spent.output = usage.output_tokens ?? 0;
        spent.cacheRead = usage.cache_read_input_tokens ?? 0;
        spent.cacheWrite = usage.cache_creation_input_tokens ?? 0;
        return;
      }
      if (event.type === "message_delta") {
        // Output tokens here are the running total for the message.
        spent.output = event.usage.output_tokens ?? spent.output;
        return;
      }
      if (event.type !== "content_block_delta") return;
      if (event.delta.type === "thinking_delta") queue("thinking", event.delta.thinking);
      else if (event.delta.type === "text_delta") queue("text", event.delta.text);
    });
    const response = await stream.finalMessage();
    flush();
    await logChain;

    const reply = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    const usage = response.usage;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    Object.assign(spent, {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead,
      cacheWrite,
    });
    const costUsd = spentCostUsd({ ...spent, model });
    await onLog(
      "stdout",
      logLine({
        type: "acpx.result",
        summary: reply ? "Replied" : response.stop_reason ?? "done",
        stopReason: response.stop_reason,
        inputTokens: usage.input_tokens + cacheWrite,
        outputTokens: usage.output_tokens,
        cachedTokens: cacheRead,
        costUsd: costUsd ?? 0,
        durationMs: Date.now() - startedAt,
      }),
    );

    if (response.stop_reason === "refusal") {
      return {
        ...errorResult("Claude declined to answer this message.", "claude_api_refusal", { ...spent, model }),
        errorFamily: "model_refusal",
      };
    }
    const cutOff = response.stop_reason === "max_tokens";
    const finalText = reply
      ? cutOff
        ? `${reply}\n\n(The reply hit its length limit. Ask me to continue.)`
        : reply
      : cutOff
        ? "(The reply hit its length limit. Ask me to continue.)"
        : "(No reply text came back. Send the message again.)";
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "api",
      model: response.model || model,
      usage: {
        inputTokens: usage.input_tokens + cacheWrite,
        outputTokens: usage.output_tokens,
        cachedInputTokens: cacheRead,
      },
      usageBasis: "per_run",
      costUsd,
      summary: finalText,
      // No provider session to resume: every turn replays this chat's history.
      clearSession: true,
      resultJson: {
        engine: "direct_api",
        engineReason: reason,
        stopReason: response.stop_reason,
        finalResponse: { disposition: "final", text: finalText },
        summary: finalText,
      },
    };
  } catch (error) {
    flush();
    await logChain;
    const aborted = ctx.signal?.aborted === true;
    const described = describeApiError(error, aborted);
    await onLog("stdout", logLine({ type: "acpx.error", message: described.message }));
    if (aborted) return stoppedResult(spent);
    return errorResult(described.message, described.code, spent);
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
  }
}

/**
 * Setup check for the direct engine: a free call (the model list) proves the
 * key works without spending anything.
 */
export async function testClaudeDirectApiEnvironment(
  config: Record<string, unknown>,
  reason: ClaudeDirectApiReason,
): Promise<{
  adapterType: string;
  status: "pass" | "warn" | "fail";
  checks: Array<{ code: string; level: "info" | "warn" | "error"; message: string; hint?: string }>;
  testedAt: string;
}> {
  const testedAt = new Date().toISOString();
  const why =
    reason === "phone"
      ? "Claude Code can't run on a phone, so this agent answers through the Anthropic API with live replies and thinking."
      : reason === "configured"
        ? "This agent answers through the Anthropic API (no Claude Code)."
        : "Claude Code isn't available here, so this agent answers through the Anthropic API.";
  const credentials = claudeDirectApiCredentials(config);
  if (!credentials) {
    return {
      adapterType: "claude_local",
      status: "warn",
      testedAt,
      checks: [
        { code: "claude_api_engine", level: "info", message: why },
        {
          code: "claude_api_key_missing",
          level: "warn",
          message: "No Anthropic API key is set for this agent yet.",
          hint: "Add one in Settings → API keys (or on this agent). Replies start as soon as a key is there.",
        },
      ],
    };
  }
  try {
    const client = new Anthropic({ apiKey: credentials.apiKey, authToken: null, baseURL: credentials.baseUrl ?? undefined, maxRetries: 0, timeout: 15_000 });
    await client.models.list({ limit: 1 });
    return {
      adapterType: "claude_local",
      status: "pass",
      testedAt,
      checks: [
        { code: "claude_api_engine", level: "info", message: why },
        { code: "claude_api_key_ok", level: "info", message: "Anthropic accepted the API key." },
      ],
    };
  } catch (error) {
    const described = describeApiError(error, false);
    const rejected = error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError;
    return {
      adapterType: "claude_local",
      status: rejected ? "fail" : "warn",
      testedAt,
      checks: [
        { code: "claude_api_engine", level: "info", message: why },
        {
          code: rejected ? "claude_api_key_rejected" : "claude_api_unreachable",
          level: rejected ? "error" : "warn",
          message: rejected ? described.message : `Could not reach Anthropic to check the key: ${described.message}`,
        },
      ],
    };
  }
}
