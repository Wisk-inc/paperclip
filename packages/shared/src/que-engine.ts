/**
 * The Que engine. Server-only: import from "@paperclipai/shared/que-engine"
 * (it calls the free-model service with Automa's token).
 *
 * Every free-model call already waits its turn in the Que queue
 * (que-queue.ts). Que calls add a 5-minute answer cache, retries for a busy
 * model, a hand-over to the next free model when one can't answer today,
 * conversations and batches.
 */
import { createHash } from "node:crypto";
import {
  describePuterError,
  formatSafetyVerdict,
  freeModelHealth,
  isLastingPuterError,
  PUTER_DEFAULT_MODEL,
  PUTER_MODEL_LIST,
  PUTER_MODEL_META,
  PUTER_MODELS,
  PuterHttpError,
  puterStream,
  type PuterMessage,
  type PuterModelKey,
} from "./puter-ai.js";
import type { QueAnswer, QueBatchItem, QueConversation, QueMessage, QueStats, QueThinkMode } from "./que.js";
import { queQueueStats } from "./que-queue.js";

export const QUE_THINK: Record<QueThinkMode, string> = {
  quick: "Answer directly in 1-2 sentences. No explanation.",
  normal: "Think briefly, then answer concisely.",
  deep: "Think step by step. Show your reasoning before answering.",
  max: "Think very carefully and thoroughly. Consider edge cases, verify your logic, show detailed reasoning before your final answer.",
};

/** The Que spec's short names for the free models. */
const QUE_ALIASES: Record<string, PuterModelKey> = {
  ultra: "nemotron-ultra", super: "nemotron-super", reasoning: "nemotron-nano-reasoning",
  lightning: "nemotron-lightning", vision: "nemotron-vision", safety: "nemotron-safety",
  deepseek: "deepseek-flash", gemma31: "gemma-31b", gemma26: "gemma-26b", qwen: "qwen-27b",
  qwenUncen: "qwen-abliterated", inkling: "inkling", inkSmall: "inkling-small", flint: "flint",
  code: "north-mini-code", atria: "atria-dawn", apodex: "apodex-mini", liquid: "lfm-tiny",
  xing: "xing4", bonsai: "bonsai-27b", router: "free-router",
};

const SAFETY_MODEL: string = PUTER_MODELS["nemotron-safety"];
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 500;
const MAX_ATTEMPTS = 8;
/** Tries on one busy model before the question goes to the next. */
const BUSY_TRIES_PER_MODEL = 3;
const BACKOFF_MS = process.env.VITEST ? 5 : 1500;
const MAX_CONVERSATIONS = 200;
const MAX_CONVERSATION_MESSAGES = 100;

/** Whose cached answers (the company) and whose conversations (the company and the person or agent). */
export interface QueScope {
  scope?: string;
  owner?: string;
}

export interface QueOptions extends QueScope {
  model?: string;
  system?: string;
  think?: QueThinkMode;
  /** Reuse an answer to the same question from the last 5 minutes (default true). */
  cache?: boolean;
  /** When the model can't answer today, hand the question to the next free model (default true). */
  fallback?: boolean;
  signal?: AbortSignal;
}

/** A free model's id from an id, a catalog key or a Que short name; null when it is none of Automa's free models. */
export function queModelId(input?: string | null): string | null {
  if (!input) return PUTER_DEFAULT_MODEL;
  if (Object.hasOwn(PUTER_MODELS, input)) return PUTER_MODELS[input as PuterModelKey];
  if (Object.hasOwn(QUE_ALIASES, input)) return PUTER_MODELS[QUE_ALIASES[input]!];
  return (PUTER_MODEL_LIST as string[]).includes(input) ? input : null;
}

function requireModel(input?: string): string {
  const id = queModelId(input);
  if (!id) throw new Error(`"${input}" is not one of Automa's free models.`);
  return id;
}

function modelLabel(model: string): string {
  const key = (Object.keys(PUTER_MODELS) as PuterModelKey[]).find((k) => PUTER_MODELS[k] === model);
  return key ? PUTER_MODEL_META[key].label : model;
}

/** The conversation with the system message (and the think instruction) first. */
function withInstructions(messages: QueMessage[], system?: string, think?: QueThinkMode): PuterMessage[] {
  const instructions = [system?.trim(), think ? QUE_THINK[think] : ""].filter(Boolean).join("\n\n");
  const copy = messages.map((message) => ({ ...message }));
  if (!instructions) return copy;
  const [first, ...rest] = copy;
  if (first?.role === "system") return [{ role: "system", content: `${first.content}\n\n${instructions}` }, ...rest];
  return [{ role: "system", content: instructions }, ...copy];
}

// ── Answer cache ─────────────────────────────────────────────────────────

interface CachedAnswer {
  scope: string;
  answer: QueAnswer;
  expires: number;
  hits: number;
}

const cache = new Map<string, CachedAnswer>();

function cacheKey(scope: string, model: string, messages: PuterMessage[]): string {
  return createHash("sha256").update(JSON.stringify([scope, model, messages])).digest("hex");
}

function cacheGet(key: string, exactModel: string | null): QueAnswer | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // An answer another model gave in its place is no answer to a call that wants this exact model.
  if (exactModel && entry.answer.model !== exactModel) return null;
  entry.hits += 1;
  cache.delete(key);
  cache.set(key, entry);
  return entry.answer;
}

function cacheSet(key: string, scope: string, answer: QueAnswer): void {
  const now = Date.now();
  for (const [k, entry] of cache) if (entry.expires <= now) cache.delete(k);
  cache.delete(key);
  cache.set(key, { scope, answer, expires: now + CACHE_TTL_MS, hits: 0 });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

// ── Asking ───────────────────────────────────────────────────────────────

class EmptyReplyError extends Error {}

/**
 * The free model to hand a question to next, picked at hand-over time: one
 * answering now before one that was busy a moment ago; never the classifier,
 * one already asked, or one held at a limit.
 */
function nextFallback(requested: string, asked: Set<string>): string | undefined {
  const health = freeModelHealth();
  const state = (id: string) => health[id]?.state ?? "ok";
  const open = (PUTER_MODEL_LIST as string[]).filter((id) =>
    id !== requested && id !== SAFETY_MODEL && !asked.has(id) && (state(id) === "ok" || state(id) === "busy"));
  return open.find((id) => state(id) === "ok") ?? open[0];
}

/** A busy provider, a dropped connection, a timeout or an empty reply: the same model may answer on a retry. */
function isBusy(error: unknown): boolean {
  if (error instanceof PuterHttpError) return error.kind === "busy";
  return error instanceof EmptyReplyError || error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

/** A refusal no retry of this model fixes today: a daily limit, a closed or withdrawn model, or a rejected request. */
function isModelRefusal(error: unknown): boolean {
  return isLastingPuterError(error) || (error instanceof PuterHttpError && (error.kind === "rejected" || error.kind === "no_tools"));
}

async function answerOnce(messages: PuterMessage[], model: string, signal?: AbortSignal) {
  let text = "";
  let reasoning = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  for await (const event of puterStream(messages, { model, signal })) {
    if (event.type === "text") text += event.text;
    else if (event.type === "reasoning") reasoning += event.text;
    else if (event.type === "done") usage = event.usage;
  }
  // A model that writes its thinking inline, before the answer.
  const inline = /^\s*<(think|thinking)>([\s\S]*?)<\/\1>/i.exec(text);
  if (inline) {
    text = text.slice(inline[0].length);
    reasoning = [reasoning.trim(), inline[2]!.trim()].filter(Boolean).join("\n\n");
  }
  text = text.trim();
  if (model === SAFETY_MODEL) text = formatSafetyVerdict(text);
  if (!text && !reasoning.trim()) throw new EmptyReplyError(`${modelLabel(model)} sent an empty reply.`);
  return { text, reasoning: reasoning.trim(), usage };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The cache, then the model (asked again while it is busy), then, when it
 * can't answer, the next free model. The answer names the model that gave it.
 */
async function ask(messages: PuterMessage[], requested: string, opts: QueOptions): Promise<QueAnswer> {
  // A safety verdict can't come from a chat model, so the classifier never hands over.
  const fallback = opts.fallback !== false && requested !== SAFETY_MODEL;
  const scope = opts.scope ?? "";
  const key = opts.cache === false ? null : cacheKey(scope, requested, messages);
  const hit = key ? cacheGet(key, fallback ? null : requested) : null;
  if (hit) return { ...hit, cached: true, attempts: 0 };

  const asked = new Set<string>();
  let attempts = 0;
  let firstError: unknown = null;
  let retries = 0;
  for (let model: string | undefined = requested; model && attempts < MAX_ATTEMPTS; model = fallback ? nextFallback(requested, asked) : undefined) {
    asked.add(model);
    for (let tries = 1; attempts < MAX_ATTEMPTS; tries += 1) {
      attempts += 1;
      try {
        const reply = await answerOnce(messages, model, opts.signal);
        const answer: QueAnswer = { ...reply, model, requestedModel: requested, cached: false, attempts };
        if (key) cacheSet(key, scope, answer);
        return answer;
      } catch (error) {
        if (opts.signal?.aborted) throw error;
        if (model === requested) firstError ??= error;
        if (isModelRefusal(error) && fallback) break;
        if (!isBusy(error)) throw model === requested ? describePuterError(error, modelLabel(model), retries) : error;
        if (fallback && tries >= BUSY_TRIES_PER_MODEL) break;
        if (attempts >= MAX_ATTEMPTS) break;
        if (model === requested) retries += 1;
        await sleep(BACKOFF_MS * tries, opts.signal);
      }
    }
  }
  if (asked.size > 1) {
    const why = describePuterError(firstError, modelLabel(requested));
    throw new Error(`${why.message} The other free models couldn't answer right now either.`);
  }
  throw describePuterError(firstError, modelLabel(requested), retries);
}

// ── Public API ───────────────────────────────────────────────────────────

/** One question (a prompt or a whole message list), answered by the free models. */
export async function queChat(prompt: string | QueMessage[], opts: QueOptions = {}): Promise<QueAnswer> {
  const model = requireModel(opts.model);
  const messages: QueMessage[] = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
  return ask(withInstructions(messages, opts.system, opts.think), model, opts);
}

/** Many questions at once; each waits its turn in the queue, and one that fails says why. */
export async function queBatch(prompts: string[], opts: QueOptions = {}): Promise<QueBatchItem[]> {
  requireModel(opts.model);
  const settled = await Promise.allSettled(prompts.map((prompt) => queChat(prompt, opts)));
  return settled.map((item) => (item.status === "fulfilled" ? item.value : { error: item.reason instanceof Error ? item.reason.message : String(item.reason) }));
}

interface Conversation {
  id: string;
  model: string;
  messages: QueMessage[];
  updatedAt: number;
  /** Messages to one conversation are answered one at a time, in order. */
  line: Promise<unknown>;
}

const conversations = new Map<string, Conversation>();
const ownerPrefix = ({ scope = "", owner = "" }: QueScope) => `${scope}\u0000${owner}\u0000`;

function ownedConversations(who: QueScope): Conversation[] {
  const prefix = ownerPrefix(who);
  return [...conversations.entries()].filter(([key]) => key.startsWith(prefix)).map(([, convo]) => convo);
}

function snapshot(convo: Conversation): QueConversation {
  return { id: convo.id, model: convo.model, messages: convo.messages.map((m) => ({ ...m })), updatedAt: new Date(convo.updatedAt).toISOString() };
}

/** A message in a conversation kept on the server; one that fails leaves the history as it was. */
export async function queConvo(prompt: string, id: string, opts: QueOptions = {}): Promise<QueAnswer> {
  const key = ownerPrefix(opts) + id;
  const model = opts.model ? requireModel(opts.model) : null;
  let convo = conversations.get(key);
  if (!convo) {
    convo = { id, model: model ?? PUTER_DEFAULT_MODEL, messages: [], updatedAt: Date.now(), line: Promise.resolve() };
    conversations.set(key, convo);
    if (conversations.size > MAX_CONVERSATIONS) {
      const oldest = [...conversations.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]!;
      conversations.delete(oldest[0]);
    }
  }
  const current = convo;
  const turn = async () => {
    if (model) current.model = model;
    if (opts.system && current.messages[0]?.role !== "system") current.messages.unshift({ role: "system", content: opts.system });
    current.messages.push({ role: "user", content: prompt });
    try {
      const answer = await ask(withInstructions(current.messages, undefined, opts.think), current.model, opts);
      current.messages.push({ role: "assistant", content: answer.text });
      if (current.messages.length > MAX_CONVERSATION_MESSAGES) {
        const system = current.messages[0]?.role === "system" ? [current.messages[0]] : [];
        current.messages = [...system, ...current.messages.slice(system.length).slice(-(MAX_CONVERSATION_MESSAGES - system.length))];
      }
      return answer;
    } catch (error) {
      current.messages.pop();
      throw error;
    } finally {
      current.updatedAt = Date.now();
    }
  };
  const next = current.line.then(turn, turn);
  current.line = next.catch(() => undefined);
  return next;
}

export function queConversation(id: string, who: QueScope = {}): QueConversation | null {
  const convo = conversations.get(ownerPrefix(who) + id);
  return convo ? snapshot(convo) : null;
}

export function queConversations(who: QueScope = {}): QueConversation[] {
  return ownedConversations(who).sort((a, b) => b.updatedAt - a.updatedAt).map(snapshot);
}

export function queClearConversation(id: string, who: QueScope = {}): boolean {
  return conversations.delete(ownerPrefix(who) + id);
}

export function queClearConversations(who: QueScope = {}): number {
  const owned = ownedConversations(who);
  for (const convo of owned) conversations.delete(ownerPrefix(who) + convo.id);
  return owned.length;
}

/** The queue (shared by the whole server), and the cached answers and conversations of one scope and owner. */
export function queStats(who: QueScope = {}): QueStats {
  const scope = who.scope ?? "";
  const now = Date.now();
  let cachedAnswers = 0;
  let cacheHits = 0;
  for (const entry of cache.values()) {
    if (entry.scope !== scope || entry.expires <= now) continue;
    cachedAnswers += 1;
    cacheHits += entry.hits;
  }
  return { ...queQueueStats(), cachedAnswers, cacheHits, conversations: ownedConversations(who).length };
}

/** Forgets every cached answer and conversation (tests). */
export function resetQue(): void {
  cache.clear();
  conversations.clear();
}
