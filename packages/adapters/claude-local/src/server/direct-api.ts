import { promises as fs } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  buildPaperclipEnv,
  normalizePaperclipWakePayload,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
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
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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
  const fromConfig = (key: string) => (typeof env[key] === "string" ? (env[key] as string).trim() : "");
  const apiKey = fromConfig("ANTHROPIC_API_KEY") || (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const baseUrl = fromConfig("ANTHROPIC_BASE_URL") || (process.env.ANTHROPIC_BASE_URL ?? "").trim() || null;
  return { apiKey, baseUrl };
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

function errorResult(message: string, code: string): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: code,
    errorMessage: message,
    provider: "anthropic",
    biller: "anthropic",
    summary: message,
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
): Promise<ContentBlock[]> {
  const ids = [...new Set(bodies.flatMap((body) => [...body.matchAll(ATTACHMENT_PATTERN)].map((match) => match[1]!)))].slice(0, MAX_IMAGES);
  if (ids.length === 0 || !ctx.authToken) return [];
  const apiUrl = buildPaperclipEnv(ctx.agent).PAPERCLIP_API_URL;
  const blocks: ContentBlock[] = [];
  for (const id of ids) {
    try {
      const response = await fetch(`${apiUrl}/api/attachments/${id}/content`, {
        headers: { authorization: `Bearer ${ctx.authToken}` },
        signal: ctx.signal,
      });
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!response.ok || !IMAGE_TYPES.has(type)) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) continue;
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: type as "image/png", data: bytes.toString("base64") },
      });
    } catch {
      await onNote(`[paperclip] Could not read attachment ${id}; the reply goes without it.\n`);
    }
  }
  return blocks;
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
  if (error instanceof Anthropic.APIError) {
    return { message: `Anthropic error ${error.status ?? ""}: ${error.message}`.replace(/\s+/g, " ").trim(), code: "claude_api_error" };
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
  const efforts = claudeLocalReasoningEffortsForModel(model);
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
  const messages = buildConversationMessages(history, [...images, { type: "text", text }]);
  const system = systemPrompt({
    agentName: ctx.agent.name,
    instructions: await readInstructions(config),
    workMode,
    conversation,
    issueTitle: asString(issue.title, "this task"),
  });

  const client = new Anthropic({
    apiKey: credentials.apiKey,
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
  try {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: 32_000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
        // Thinking stays on (adaptive) and is shown: the summarized text
        // streams into the chat's thinking panel.
        thinking: { type: "adaptive", display: "summarized" },
        ...(effort ? { output_config: { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" } } : {}),
      },
      { signal: ctx.signal },
    );
    stream.on("streamEvent", (event) => {
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
    const costUsd = estimateClaudeCostUsd(model, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite,
    });
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
      return errorResult("Claude declined to answer this message.", "claude_api_refusal");
    }
    const finalText =
      reply ||
      (response.stop_reason === "max_tokens"
        ? "(The reply hit its length limit. Ask me to continue.)"
        : "(No reply text came back. Send the message again.)");
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
    const described = describeApiError(error, ctx.signal?.aborted === true);
    await onLog("stdout", logLine({ type: "acpx.error", message: described.message }));
    return errorResult(described.message, described.code);
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
    const client = new Anthropic({ apiKey: credentials.apiKey, baseURL: credentials.baseUrl ?? undefined, maxRetries: 0, timeout: 15_000 });
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
