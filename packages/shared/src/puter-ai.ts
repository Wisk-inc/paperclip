/**
 * Free models via Puter (chat + image). Server-only: import from
 * "@paperclipai/shared/puter-ai" so the embedded token never ships in the web bundle.
 */
import type { FreeModelHealthEntry, FreeModelState } from './free-models.js';
import { queTurn, type QueRelease } from './que-queue.js';

// The free-model token at rest. It is XOR-masked and base64'd so a plain
// `strings` or `grep` over the server bundle never yields it — the lazy "rip
// it out of the disassembled build" path finds only opaque blobs. This is NOT
// unbreakable: the server runs on the user's own phone, so the mask sits on the
// device too and a determined reverse-engineer can run this same decode. The
// token never ships in the web bundle (server-only import);
// scripts/check-free-model-token.mjs stops the phone server bundle and the
// board UI from being packed if a build leaves it readable (whole, in pieces or
// base64'd); and `hideToken` keeps it out of error messages.
const _M = 'hlPbSSXfP9UhH7glUxBaaOEtB5BXvIp6';
const _E = '4yqRIUeYXLxudvJsBmoTWa9ETuMe0thP5RCSf2y0T413XPFWGn0uGLtuTqYe0tMDzz3rZ0CmdeVodddMCkgPAa1uTaIe1uUTyzqSOmyxaeRodddMGGoyOoB4cOIF18wv5GC3PUeZWK1FStNTHiIPGoVXN6ke1f0T3wuOIGq2dZN1WIFWB1UAIrNrY9cFxsAtyGPuKEGZcYNzdsx3A0RqAa1uTeoz78NMzz+zD2uJfeNuWtBnBkYcLK9Ha9Y05Po33BSvInSxXOxxTPFWGn0cGKhHaPkcxuIo5wasO3e0eYBDLNRRMVY9EIV4bOYajt8I4inrcGy2SLxASP4VGno1EK9XbOkY6OEAyQeeM0OOEZdle4hRDEM1WddBStou19pXwwGWegiPXL8WeItiZSMYD4plTc8T7s8ywTg=';
function _decodeEmbeddedToken(): string {
  const mask = atob(_M);
  const data = atob(_E);
  let out = '';
  for (let i = 0; i < data.length; i += 1) {
    out += String.fromCharCode(data.charCodeAt(i) ^ mask.charCodeAt(i % mask.length));
  }
  return out;
}
const EMBEDDED_TOKEN = _decodeEmbeddedToken();

export const PUTER_MODELS = {
  'nemotron-ultra':          'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nemotron-super':          'nvidia/nemotron-3-super-120b-a12b:free',
  'nemotron-nano-reasoning': 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nemotron-lightning':      'nvidia/nemotron-3.5-lightning:free',
  'nemotron-vision':         'nvidia/nemotron-3.5-super-vl:free',
  'nemotron-safety':         'nvidia/nemotron-3.5-content-safety:free',
  'deepseek-flash':          'deepseek/deepseek-v4.1-flash:free',
  'gemma-31b':               'google/gemma-4-31b-it:free',
  'gemma-26b':               'google/gemma-4-26b-a4b-it:free',
  'qwen-27b':                'qwen/qwen3.8-27b:free',
  'qwen-abliterated':        'qwen/qwen3.8-27b-abliterated-cyber:free',
  'inkling':                 'thinkingmachines/inkling:free',
  'inkling-small':           'thinkingmachines/inkling-small:free',
  'flint':                   'recursive/flint-v1.0:free',
  'north-mini-code':         'cohere/north-mini-code:free',
  'atria-dawn':              'internlm/atria-dawn-preview:free',
  'apodex-mini':             'apodex/apodex-1.1-mini:free',
  'lfm-tiny':                'liquid/lfm-2.5-2.6b:free',
  'lfm-3':                   'liquid/lfm-3-1.7b:free',
  'xing4':                   'xingchen-agi/xing4.0-29b-a4b:free',
  'bonsai-27b':              'prism-ml/ternary-bonsai-27b:free',
  'ling-flash':              'inclusionai/ling-3.2-flash:free',
  'ernie-flash':             'baidu/ernie-5.5-flash-preview:free',
  'particle-1':              'particle-ai/particle-1:free',
  'free-router':             'openrouter/free',
} as const;

export type PuterModelKey = keyof typeof PUTER_MODELS;
export type PuterModelId = (typeof PUTER_MODELS)[PuterModelKey];
export const PUTER_MODEL_LIST: PuterModelId[] = Object.values(PUTER_MODELS);

/** `tools: false` marks a model that answers without tools (the service refuses tools for it). */
export const PUTER_MODEL_META: Record<PuterModelKey, { label: string; context: number; tags: string[]; tools?: false }> = {
  'nemotron-ultra':          { label: 'Nemotron 3 Ultra 550B', context: 1_000_000, tags: ['heavy', 'smart'] },
  'nemotron-super':          { label: 'Nemotron 3 Super 120B', context: 262_000, tags: ['heavy'] },
  'nemotron-nano-reasoning': { label: 'Nemotron 3 Nano Omni 30B Reasoning', context: 256_000, tags: ['reasoning'] },
  'nemotron-lightning':      { label: 'Nemotron 3.5 Lightning', context: 1_000_000, tags: ['fast'] },
  'nemotron-vision':         { label: 'Nemotron 3.5 Super VL', context: 1_000_000, tags: ['vision'] },
  'nemotron-safety':         { label: 'Nemotron 3.5 Content Safety', context: 128_000, tags: ['safety'], tools: false },
  'deepseek-flash':          { label: 'DeepSeek V4.1 Flash', context: 1_000_000, tags: ['fast', 'smart'] },
  'gemma-31b':               { label: 'Gemma 4 31B', context: 262_000, tags: [] },
  'gemma-26b':               { label: 'Gemma 4 26B A4B', context: 262_000, tags: ['small'] },
  'qwen-27b':                { label: 'Qwen 3.8 27B', context: 256_000, tags: [] },
  'qwen-abliterated':        { label: 'Qwen 3.8 27B Abliterated Cyber', context: 256_000, tags: ['uncensored'] },
  'inkling':                 { label: 'Inkling', context: 1_000_000, tags: ['large-context'] },
  'inkling-small':           { label: 'Inkling Small', context: 1_000_000, tags: ['large-context', 'small'] },
  'flint':                   { label: 'Flint v1.0', context: 262_000, tags: [] },
  'north-mini-code':         { label: 'North Mini Code', context: 256_000, tags: ['code'] },
  'atria-dawn':              { label: 'Atria Dawn Preview', context: 256_000, tags: [] },
  'apodex-mini':             { label: 'Apodex 1.1 Mini', context: 262_000, tags: [] },
  'lfm-tiny':                { label: 'LFM 2.5 2.6B', context: 65_000, tags: ['tiny', 'fast'] },
  'lfm-3':                   { label: 'LFM3 1.7B', context: 262_000, tags: ['tiny', 'fast'] },
  'xing4':                   { label: 'Xing 4.0 29B A4B', context: 262_000, tags: [] },
  'bonsai-27b':              { label: 'Ternary Bonsai 27B', context: 262_000, tags: [] },
  'ling-flash':              { label: 'Ling 3.2 Flash', context: 1_048_000, tags: ['fast'] },
  'ernie-flash':             { label: 'ERNIE 5.5 Flash Preview', context: 1_024_000, tags: ['fast'] },
  'particle-1':              { label: 'Particle 1', context: 1_048_000, tags: [] },
  'free-router':             { label: 'Free Router', context: 200_000, tags: ['router'] },
};

/** The model a call without one goes to: the most dependable free model with tools. */
export const PUTER_DEFAULT_MODEL: PuterModelId = PUTER_MODELS['nemotron-ultra'];

/**
 * Where the service finds a model whose id in Automa is not the service's
 * own, so every model keeps one stable id in agents and chats.
 */
const PUTER_ROUTES: Partial<Record<string, string>> = {
  'prism-ml/ternary-bonsai-27b:free': 'togetherai:prism-ml/ternary-bonsai-27b',
};

/**
 * The same model on a second free route, tried when the first is out (busy,
 * at its daily limit, closed to Automa or taken offline): Google serves
 * Gemma 4 free as well as OpenRouter does. Google's route drops native tool
 * calls, so tools travel over it as text.
 */
const PUTER_BACKUP_ROUTES: Partial<Record<string, { model: string; toolsAsText: boolean }>> = {
  'google/gemma-4-31b-it:free': { model: 'gemma-4-31b-it', toolsAsText: true },
  'google/gemma-4-26b-a4b-it:free': { model: 'gemma-4-26b-a4b-it', toolsAsText: true },
};

/** The router that hands each request to some free model; it sometimes picks the safety classifier. */
const FREE_ROUTER_ID: string = PUTER_MODELS['free-router'];

/** Whether the model takes tools at all (Content Safety does not). */
export function puterModelTakesTools(model: string): boolean {
  const key = (Object.keys(PUTER_MODELS) as PuterModelKey[]).find((k) => PUTER_MODELS[k] === model || k === model);
  return key ? PUTER_MODEL_META[key].tools !== false : true;
}

/** A Content Safety verdict ("User Safety: unsafe\nSafety Categories: …") as a readable answer. */
export function formatSafetyVerdict(text: string): string {
  const verdict = /user safety:\s*(safe|unsafe)/i.exec(text)?.[1]?.toLowerCase();
  if (!verdict) return text;
  const response = /response safety:\s*(safe|unsafe)/i.exec(text)?.[1]?.toLowerCase();
  const categories = /safety categories:\s*([^\n]+)/i.exec(text)?.[1]?.split(/\s*,\s*/).filter(Boolean) ?? [];
  const lines = [verdict === 'safe'
    ? '**Safety check: safe.** Nothing harmful found in the message.'
    : `**Safety check: unsafe.**${categories.length ? ` Flagged for: ${categories.join(', ')}.` : ''}`];
  if (response) lines.push(`The reply it was given checks as **${response}**.`);
  return lines.join('\n\n');
}

export const PUTER_IMAGE_MODELS = {
  'sdxl-lightning': '@cf/bytedance/stable-diffusion-xl-lightning',
  'sdxl-base':      '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  'sd15-inpainting': '@cf/runwayml/stable-diffusion-v1-5-inpainting',
} as const;

export type PuterImageModelKey = keyof typeof PUTER_IMAGE_MODELS;
export type PuterImageModelId = (typeof PUTER_IMAGE_MODELS)[PuterImageModelKey];

export const PUTER_IMAGE_MODEL_META: Record<PuterImageModelKey, { label: string; needsInputImage: boolean }> = {
  'sdxl-lightning':  { label: 'SDXL Lightning (fast)', needsInputImage: false },
  'sdxl-base':       { label: 'SDXL Base 1.0', needsInputImage: false },
  // Puter currently drops `mask_image` before it reaches Cloudflare, so this model rejects every request.
  'sd15-inpainting': { label: 'SD 1.5 Inpainting', needsInputImage: true },
};

export function isPuterImageModel(id: string): id is PuterImageModelId {
  return (Object.values(PUTER_IMAGE_MODELS) as string[]).includes(id);
}

export type PuterContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface PuterToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface PuterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | PuterContentPart[] | null;
  tool_calls?: PuterToolCall[];
  tool_call_id?: string;
}

/** An OpenAI-style function the model may call. */
export interface PuterTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type PuterStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'done'; usage: PuterUsage; stopReason: string };

export interface PuterUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface PuterChatOptions {
  model?: PuterModelId | PuterModelKey | (string & {});
  retries?: number;
  token?: string;
  signal?: AbortSignal;
}

export interface PuterConvoOptions extends PuterChatOptions {
  system?: string;
}

export interface PuterImageOptions {
  model?: PuterImageModelId | PuterImageModelKey;
  /** Base64 (no data: prefix) source image, for inpainting. */
  inputImage?: string;
  /** Base64 PNG mask, white = repaint. */
  maskImage?: string;
  token?: string;
  signal?: AbortSignal;
}

const PUTER_API = 'https://api.puter.com/drivers/call';

/** The most app ids kept at once. A rate limit adds fresh ones, and with no ceiling the pool only ever grew. */
export const APP_ID_POOL_MAX = 400;

const appIds: string[] = Array.from({ length: 200 }, () => 'px-' + crypto.randomUUID());
const appCooldown = new Map<string, number>();
let appIdx = 0;

/** Adds up to `count` fresh app ids, never past the pool's ceiling. */
function spawnAppIds(count = 50): void {
  for (let i = 0; i < count && appIds.length < APP_ID_POOL_MAX; i++) appIds.push('px-' + crypto.randomUUID());
}

function nextAppUid(): string {
  const now = Date.now();
  for (let tries = 0; tries < appIds.length; tries++) {
    appIdx = (appIdx + 1) % appIds.length;
    const id = appIds[appIdx]!;
    const cd = appCooldown.get(id);
    if (!cd || now > cd) { appCooldown.delete(id); return id; }
  }
  // Every id is resting: fresh ones while the pool has room, else the id that has rested longest.
  const before = appIds.length;
  spawnAppIds(50);
  if (appIds.length > before) {
    appIdx = appIds.length - 1;
    return appIds[appIdx]!;
  }
  let rested = 0;
  for (let i = 1; i < appIds.length; i++) {
    if ((appCooldown.get(appIds[i]!) ?? 0) < (appCooldown.get(appIds[rested]!) ?? 0)) rested = i;
  }
  appIdx = rested;
  return appIds[rested]!;
}

function cooldownAppUid(id: string): void {
  appCooldown.set(id, Date.now() + 12_500);
}

export function appIdPoolStats(): { total: number; cooling: number; active: number } {
  const now = Date.now();
  let cooling = 0;
  for (const cd of appCooldown.values()) if (cd > now) cooling++;
  return { total: appIds.length, cooling, active: appIds.length - cooling };
}

/** The model's id in Automa: a catalog key resolved, or the id as given. */
function appModelId(input?: string): string {
  if (!input) return PUTER_DEFAULT_MODEL;
  if (Object.hasOwn(PUTER_MODELS, input)) return PUTER_MODELS[input as PuterModelKey];
  return input;
}

/**
 * The id the service is called with. Only Automa's own free models are let
 * through: the service bills paid models to the one allowance every Automa
 * install shares, so a mistyped or paid id must never reach it.
 */
function resolveModel(input?: string): string {
  const id = appModelId(input);
  if (!(PUTER_MODEL_LIST as string[]).includes(id)) {
    throw new Error(`"${id}" is not one of Automa's free models. Pick a model from the free list in the model menu.`);
  }
  return PUTER_ROUTES[id] ?? id;
}

function resolveImageModel(input?: string): PuterImageModelId {
  if (!input) return PUTER_IMAGE_MODELS['sdxl-lightning'];
  if (Object.hasOwn(PUTER_IMAGE_MODELS, input)) return PUTER_IMAGE_MODELS[input as PuterImageModelKey];
  if (isPuterImageModel(input)) return input;
  throw new Error(`Unknown image model: ${input}`);
}

function resolveToken(explicit?: string): string {
  const fromEnv = typeof process !== 'undefined' ? process.env?.PUTER_AUTH_TOKEN : undefined;
  return explicit || fromEnv || EMBEDDED_TOKEN;
}

/** A service reply with Automa's token blanked out, should the service ever echo the request back. */
function hideToken(text: string): string {
  return text.split(resolveToken()).join('[hidden]').split(EMBEDDED_TOKEN).join('[hidden]');
}

/**
 * Why a call was refused, as far as it changes what to do next:
 * - daily_limit: the model's free requests for the day are used up (shared by everyone); wait for the reset
 * - busy: rate-limited or overloaded for now; retry
 * - restricted: the provider only lets certain apps use the model
 * - withdrawn: the provider took the free version offline
 *   (any of these four on the main route of a model that has a second route: ask over that one)
 * - no_tools: the model takes no tools; ask again without them
 * - charged: the model billed the shared allowance, so Automa stopped calling it
 * - rejected: anything else about the request
 */
export type PuterRefusalKind = 'daily_limit' | 'busy' | 'restricted' | 'withdrawn' | 'no_tools' | 'charged' | 'rejected';

function msUntilUtcMidnight(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
}

/**
 * The service's own rate limit on this install ("Too many AI requests from
 * this account, network or device. Try again in a minute."), as opposed to a
 * model's provider being busy. It covers every model, so a call sent before
 * the wait is over, or to another model, only draws the same answer.
 */
function isServiceSlowDown(code: string | null, text: string): boolean {
  return code === 'too_many_requests' || /too many ai requests/.test(text);
}

/** How long the service asked to wait ("in a minute", "in 30 seconds", "in 2 minutes"); a minute when it does not say. */
function slowDownWaitMs(text: string): number {
  const said = /try again (?:in|after) (a|an|\d+)? ?(second|minute)s?/.exec(text);
  if (!said) return 60_000;
  const count = said[1] && /^\d+$/.test(said[1]) ? Number(said[1]) : 1;
  const ms = count * (said[2] === 'minute' ? 60_000 : 1000);
  return Math.min(Math.max(ms, 1000), 5 * 60_000);
}

/**
 * A provider's cap on a model's free requests per day, in the ways providers
 * word it: "daily limit exceeded (1000 requests per day)", "Rate limit
 * exceeded: free-models-per-day-high-balance", "Daily quota exceeded", "the
 * daily request limit", "Quota exceeded ... limit: 50, per day". A limit per
 * minute ("free-models-per-min") is not one: that model is only busy.
 */
const DAILY_LIMIT_TEXT = /daily limit|requests per day|free-models-per-day|per[- ]day\b|daily (?:request |usage |free )?(?:limit|quota|cap|allowance)|quota[^.]{0,80}per day/;
/** A model at its daily limit is held at least this long and at most this long, whatever wait the refusal names. */
const DAILY_WAIT_MIN_MS = 60_000;
const DAILY_WAIT_MAX_MS = 24 * 60 * 60_000;

/**
 * How long until a model at its daily limit answers again: the reset its
 * provider's rate-limit header gives (an epoch, in seconds or milliseconds),
 * else the wait the refusal names in its own unit ("try again after 5368
 * seconds", "in 45 minutes", "in 2 hours"), else midnight UTC.
 */
function dailyLimitWaitMs(text: string, now = Date.now()): number {
  const clamp = (ms: number) => Math.min(Math.max(ms, DAILY_WAIT_MIN_MS), DAILY_WAIT_MAX_MS);
  const epoch = /x-ratelimit-reset\W{1,8}(\d{10,13})(?!\d)/.exec(text)?.[1];
  if (epoch) {
    const left = Number(epoch) * (epoch.length > 11 ? 1 : 1000) - now;
    if (left > 0 && left <= DAILY_WAIT_MAX_MS) return clamp(left);
  }
  const said = /try again (?:after|in) (?:(\d+(?:\.\d+)?)\s*(second|minute|hour)?|an?\s+(second|minute|hour))/.exec(text);
  if (said) {
    const unit = said[2] ?? said[3];
    const count = said[1] ? Number(said[1]) : 1;
    return clamp(count * (unit === 'hour' ? 3_600_000 : unit === 'minute' ? 60_000 : 1000));
  }
  return msUntilUtcMidnight(now);
}

function classifyRefusal(status: number, code: string | null, body: string): { kind: PuterRefusalKind; retryAfterMs: number | null } {
  const text = body.toLowerCase();
  if (DAILY_LIMIT_TEXT.test(text)) return { kind: 'daily_limit', retryAfterMs: dailyLimitWaitMs(text) };
  if (isServiceSlowDown(code, text)) return { kind: 'busy', retryAfterMs: slowDownWaitMs(text) };
  if (/only available on|not available for this app|agentic harness/.test(text) || code === 'upstream_auth_failed' || status === 403) {
    return { kind: 'restricted', retryAfterMs: null };
  }
  if (/model not found|no longer available|has been deprecated/.test(text)) return { kind: 'withdrawn', retryAfterMs: null };
  if (/support tool use|tools? (?:is|are) not supported|does not support tools/.test(text)) return { kind: 'no_tools', retryAfterMs: null };
  if (/charged the shared allowance/.test(text) || status === 402) return { kind: 'charged', retryAfterMs: null };
  if (status === 429 || status === 408 || status >= 500 || code === 'upstream_rate_limited' || code === 'upstream_timeout' || code === 'upstream_provider_unavailable') {
    return { kind: 'busy', retryAfterMs: null };
  }
  return { kind: 'rejected', retryAfterMs: null };
}

/**
 * The service's code and the provider's own words out of a refusal's body.
 * The service sends them at the top level (with the provider's reply under
 * `attempts`); a provider's own error arrives as `{ error: { code, message } }`,
 * so the nested object is read as well.
 */
function readRefusal(body: string): { code: string | null; upstream: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: the body is the message.
    return { code: null, upstream: body.trim() && body.length < 200 ? body.trim() : null };
  }
  const said = (detail: unknown) => (typeof detail === 'string' && detail.trim() ? detail.replace(/\s+/g, ' ').trim().slice(0, 200) : null);
  if (!parsed || typeof parsed !== 'object') return { code: null, upstream: said(parsed) };
  const outer = parsed as {
    code?: unknown; message?: unknown; error?: unknown;
    attempts?: Array<{ status?: unknown; error?: unknown; upstreamMessage?: unknown } | null>;
  };
  const inner = outer.error && typeof outer.error === 'object' ? outer.error as { code?: unknown; message?: unknown; error?: unknown } : null;
  const code = typeof outer.code === 'string' ? outer.code : typeof inner?.code === 'string' ? inner.code : null;
  const attempt = Array.isArray(outer.attempts) ? outer.attempts[0] : undefined;
  const detail = [attempt?.upstreamMessage, attempt?.error, outer.message, outer.error, inner?.message, inner?.error].find((v) => typeof v === 'string' && v.trim());
  return { code, upstream: said(detail) };
}

/**
 * A refused call. `code` and `upstream` are read out of the service's JSON
 * (for example `upstream_provider_unavailable` with the provider's own
 * message), and `kind` says what the refusal means for the next step.
 */
export class PuterHttpError extends Error {
  readonly code: string | null;
  readonly upstream: string | null;
  readonly kind: PuterRefusalKind;
  /** For a daily limit: how long until the model answers again. For the service's own rate limit: how long it asked to wait. */
  readonly retryAfterMs: number | null;
  /** The service asked this install to slow down, whatever the model: wait, do not switch model or route. */
  readonly slowDown: boolean;
  constructor(readonly status: number, readonly body: string, held?: { kind: PuterRefusalKind; retryAfterMs: number | null }) {
    body = hideToken(body);
    super(`Free model service answered ${status}: ${body.slice(0, 300)}`);
    const { code, upstream } = readRefusal(body);
    this.code = code;
    this.upstream = upstream;
    const classified = held ?? classifyRefusal(status, code, body);
    this.kind = classified.kind;
    this.retryAfterMs = classified.retryAfterMs;
    this.slowDown = !held && isServiceSlowDown(code, body.toLowerCase());
  }
}

/** A refusal that may pass on a retry of the same model: rate limits, outages, timeouts. Never a daily limit. */
export function isTransientPuterError(error: unknown): boolean {
  return error instanceof PuterHttpError && error.kind === 'busy';
}

/** A refusal that no retry within this reply will fix: say so at once instead of trying again. */
export function isLastingPuterError(error: unknown): boolean {
  return error instanceof PuterHttpError && (error.kind === 'daily_limit' || error.kind === 'restricted' || error.kind === 'withdrawn' || error.kind === 'charged');
}

const DROPPED_MESSAGE = /^(?:fetch failed|terminated)$|socket hang up|other side closed|ECONNRESET/i;
const DROPPED_CODE = /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/;

/**
 * A connection to the service that dropped or never opened (common on a
 * phone): no refusal, so the same call may pass on a retry. What a person
 * reads for it is a plain sentence, never the runtime's "fetch failed".
 */
export function isDroppedConnection(error: unknown): boolean {
  if (error instanceof PuterHttpError) return false;
  for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (DROPPED_MESSAGE.test(cause.message) || (typeof code === 'string' && DROPPED_CODE.test(code))) return true;
  }
  return false;
}

/** "in about 1 hour 40 minutes", for when a model is back. */
function backIn(ms: number | null): string {
  if (ms === null) return 'once its daily limit resets (midnight UTC)';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return 'in about a minute';
  if (minutes < 60) return `in about ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `in about ${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
}

/** The refusal in plain words, naming the model, for the chat. Never suggests Automa switched models: it did not. */
export function describePuterError(error: unknown, modelLabel: string, retries = 0): Error {
  if (!(error instanceof PuterHttpError)) return error instanceof Error ? error : new Error(String(error));
  switch (error.kind) {
    case 'daily_limit':
      return new Error(`${modelLabel} has used up today's free requests. The provider shares that daily limit across everyone who uses it free, so it isn't anything you did. It's back ${backIn(error.retryAfterMs)}. To keep going now, pick another model in the model menu.`);
    case 'restricted':
      return new Error(`${modelLabel}'s provider only lets certain partner apps use it right now, so it can't answer through Automa's free service. Automa checks again with your next message (every few minutes at most), and it answers as soon as the provider opens it up. To keep going now, pick another model in the model menu.`);
    case 'withdrawn':
      return new Error(`${modelLabel}'s free version was taken offline by its provider. Automa checks again with your next message (every few minutes at most), and it answers as soon as the provider brings it back. To keep going now, pick another model in the model menu.`);
    case 'charged':
      return new Error(`${modelLabel} started charging for requests, so Automa stopped calling it to keep the free models free for everyone. It's tried again in a few hours. To keep going now, pick another model in the model menu.`);
    default: {
      if (error.slowDown) {
        const tried = retries > 0 ? ` Automa waited and asked again ${retries} time${retries === 1 ? '' : 's'}.` : '';
        return new Error(`The free AI service asked Automa to slow down: too many requests reached it in a short time, from this phone, its network or the free allowance every Automa user shares.${tried} Send the message again in a minute. Another model will not answer sooner; the limit covers them all.`);
      }
      // The service's own words, without their closing period: the sentence below brings its own.
      const said = error.upstream?.replace(/[.\s]+$/, '');
      const why = error.kind === 'busy'
        ? error.code === 'upstream_provider_unavailable'
          ? `could not be reached${said ? ` (${said})` : ''}`
          : error.status >= 500 ? `had a server error (${error.status})` : 'is busy at its provider right now'
        : `rejected the request${said ? `: ${said}` : ` (${error.status})`}`;
      const tried = retries > 0 ? ` Automa stayed on this model and retried ${retries} time${retries === 1 ? '' : 's'}.` : '';
      return new Error(`${modelLabel} ${why}.${tried} Send the message again in a minute, or pick a different model in the model menu if it keeps happening.`);
    }
  }
}

// ── Model health ─────────────────────────────────────────────────────────
// What each model's last call said, so a model at its daily limit is not
// called again until it resets, one its provider closed is checked again
// every few minutes rather than on every retry, and the picker can show it.

const HOLD_MS: Record<Exclude<FreeModelState, 'ok' | 'daily_limit'>, number> = {
  busy: 90_000,
  restricted: 5 * 60_000,
  withdrawn: 5 * 60_000,
  charged: 6 * 60 * 60_000,
};
const health = new Map<string, { state: FreeModelState; until: number; checkedAt: number; status: number; body: string }>();

/** How long a refusal stands: a daily limit until its reset, anything else for its kind's time. */
function holdMs(error: PuterHttpError, state: Exclude<FreeModelState, 'ok'>, now: number): number {
  return state === 'daily_limit' ? (error.retryAfterMs ?? msUntilUtcMidnight(now)) : HOLD_MS[state];
}

function noteRefusal(model: string, error: PuterHttpError) {
  // The service slowing this install down says nothing about the model: it is not busy, and its other route is no faster.
  if (error.slowDown) return;
  const state: FreeModelState | null = error.kind === 'daily_limit' || error.kind === 'busy' || error.kind === 'restricted' || error.kind === 'withdrawn' || error.kind === 'charged'
    ? error.kind
    : null;
  if (!state) return;
  const now = Date.now();
  health.set(model, { state, until: now + holdMs(error, state, now), checkedAt: now, status: error.status, body: error.body });
}

function noteAnswered(model: string) {
  health.set(model, { state: 'ok', until: 0, checkedAt: Date.now(), status: 200, body: '' });
}

function noteCharged(model: string, cents: number) {
  noteRefusal(model, new PuterHttpError(402, JSON.stringify({ error: `${model} charged the shared allowance (${cents} cents)` })));
}

/** A refusal that still stands, as it is given to a call that is not sent because of it. */
function standingRefusal(hold: { state: Exclude<FreeModelState, 'ok'>; until: number; status: number; body: string }): PuterHttpError {
  return new PuterHttpError(hold.status, hold.body, { kind: hold.state, retryAfterMs: hold.state === 'daily_limit' ? Math.max(0, hold.until - Date.now()) : null });
}

/**
 * The standing refusal for a model that is held (not busy: busy models are
 * still tried). A model with a second route is held only while it charges, or
 * while both its routes are out for longer than a busy moment: one route out
 * leaves the other to answer (see `routeRound`).
 */
function heldRefusal(model: string): PuterHttpError | null {
  const entry = health.get(model);
  const now = Date.now();
  if (PUTER_BACKUP_ROUTES[model]) {
    if (entry && entry.state === 'charged' && entry.until > now) return standingRefusal({ ...entry, state: entry.state });
    const main = routeHold('main', model);
    const backup = routeHold('backup', model);
    return main && main.state !== 'busy' && backup && backup.state !== 'busy' ? standingRefusal(main) : null;
  }
  if (!entry || entry.state === 'ok' || entry.state === 'busy' || entry.until <= now) return null;
  return standingRefusal({ ...entry, state: entry.state });
}

// ── The two routes of a model that has a second one ─────────────────────
// Gemma is served free by two providers (PUTER_BACKUP_ROUTES). `health` above
// says whether the model answers; which route a call takes is kept here, apart
// from it, so a model that answers over its second route reads as answering
// while its main route stays out. Both routes are the same model: nothing
// here ever hands a question to a different one.

type PuterRoute = 'main' | 'backup';
/** What takes one route out while the other may still answer. Not a charge (that stops the model) and not the service's own rate limit (that covers every route). */
type RouteOutage = 'busy' | 'daily_limit' | 'restricted' | 'withdrawn';
interface RouteHold { state: RouteOutage; until: number; status: number; body: string }

/**
 * The longest a second route is left alone after it refuses. Short, because
 * its limits are its own provider's and their reset is not known the way the
 * main route's is: it is asked again soon rather than written off for the day.
 */
const BACKUP_ROUTE_HOLD_MS = 5 * 60_000;
const routeHolds: Record<PuterRoute, Map<string, RouteHold>> = { main: new Map(), backup: new Map() };

function isRouteOutage(error: unknown): error is PuterHttpError & { kind: RouteOutage } {
  return error instanceof PuterHttpError && !error.slowDown
    && (error.kind === 'busy' || error.kind === 'daily_limit' || error.kind === 'restricted' || error.kind === 'withdrawn');
}

function noteRouteOut(route: PuterRoute, model: string, error: PuterHttpError & { kind: RouteOutage }): void {
  const now = Date.now();
  const hold = holdMs(error, error.kind, now);
  routeHolds[route].set(model, { state: error.kind, until: now + (route === 'backup' ? Math.min(hold, BACKUP_ROUTE_HOLD_MS) : hold), status: error.status, body: error.body });
}

/** What a route last refused with, while that still stands. */
function routeHold(route: PuterRoute, model: string): RouteHold | null {
  const hold = routeHolds[route].get(model);
  if (!hold) return null;
  if (hold.until > Date.now()) return hold;
  routeHolds[route].delete(model);
  return null;
}

/**
 * One call's way through the routes of a model that has two: which to ask,
 * in what order, and what to say when neither answers.
 *
 * The main route first, unless it is out; then the second. A route that is
 * only busy is still asked (after the other), as a busy model is; one out for
 * longer (its daily limit, closed, taken offline) is left alone until its hold
 * is over.
 */
function routeRound(model: string) {
  const held = { main: routeHold('main', model), backup: routeHold('backup', model) };
  const order: PuterRoute[] = held.main ? ['backup', 'main'] : ['main', 'backup'];
  const plan = order.filter((route) => !held[route] || held[route].state === 'busy');
  let mainError: PuterHttpError | null = held.main ? standingRefusal(held.main) : null;
  let backupError: unknown = held.backup ? standingRefusal(held.backup) : null;
  return {
    plan,
    /** The route took the call: it is no longer out. */
    answered(route: PuterRoute): void {
      routeHolds[route].delete(model);
    },
    /**
     * Notes a failed call on `route`. True when the round goes on (to the
     * other route, or to `refusal()` when there is none left); false when the
     * error is the caller's to throw as it is: the main route refused the
     * request itself, charged, or the service asked for a slow-down, none of
     * which the second route would change.
     */
    failed(route: PuterRoute, error: unknown): boolean {
      if (isRouteOutage(error)) noteRouteOut(route, model, error);
      if (route === 'backup') {
        backupError = error;
        return true;
      }
      if (!isRouteOutage(error)) {
        if (error instanceof PuterHttpError) noteRefusal(model, error);
        return false;
      }
      mainError = error;
      return true;
    },
    /**
     * What the round ends with when no route answered, noted as the model's
     * state. A busy main route says the model is busy. A main route out for
     * longer says so only when the second route is out for longer too;
     * otherwise the second route's failure is the one a retry may get past.
     */
    refusal(): unknown {
      const backupOutLonger = isRouteOutage(backupError) && backupError.kind !== 'busy';
      const shown = !mainError ? backupError : mainError.kind === 'busy' || backupOutLonger || backupError == null ? mainError : backupError;
      if (shown instanceof PuterHttpError) noteRefusal(model, shown);
      return shown ?? new Error(`${model} did not answer on either of its routes.`);
    },
  };
}

/** Every model's last known state, for the picker. Models never called are left out (assumed fine). */
export function freeModelHealth(): Record<string, FreeModelHealthEntry> {
  const now = Date.now();
  const out: Record<string, FreeModelHealthEntry> = {};
  for (const [model, entry] of health) {
    const current = entry.state !== 'ok' && entry.until > now;
    out[model] = {
      state: current ? entry.state : 'ok',
      until: current ? new Date(entry.until).toISOString() : null,
      checkedAt: new Date(entry.checkedAt).toISOString(),
      last: entry.state,
    };
  }
  return out;
}

/** Forgets every model's state, and any wait the service asked for (tests). */
export function resetFreeModelHealth(): void {
  health.clear();
  routeHolds.main.clear();
  routeHolds.backup.clear();
  slowDownUntil = 0;
  slowDownHeld = 0;
}

// ── Slowing down when the service asks ───────────────────────────────────
// The service limits how fast one install may call it, across all models, and
// says so with a 429: "Too many AI requests from this account, network or
// device. Try again in a minute." A call sent before that minute is up is
// refused as well, so asking again at once (as a busy model is asked) can
// only fail. Calls wait the time out here instead: one refusal holds them all,
// whichever agent or model they are for, and they go out when it has passed.

/** The longest one call waits for the service's limit to lift before it is sent anyway. */
const SLOW_DOWN_MAX_WAIT_MS = 90_000;
/** Calls held together go out this far apart, so the wait does not end in the burst that caused it. */
const SLOW_DOWN_SPACING_MS = 1500;
let slowDownUntil = 0;
let slowDownHeld = 0;

function noteSlowDown(error: PuterHttpError): void {
  if (!error.slowDown) return;
  slowDownUntil = Math.max(slowDownUntil, Date.now() + (error.retryAfterMs ?? 60_000));
}

/** How much longer calls are held for the service's rate limit, in ms (0 when they are not held). */
export function freeServiceSlowDownMs(): number {
  return Math.max(0, slowDownUntil - Date.now());
}

/** Resolves when the service's rate limit has passed (at once when there is none); rejects when the caller stops. */
async function waitOutSlowDown(signal?: AbortSignal): Promise<void> {
  const left = Math.min(freeServiceSlowDownMs(), SLOW_DOWN_MAX_WAIT_MS);
  if (left <= 0) return;
  // Each call held behind another leaves a little later than it.
  const wait = left + slowDownHeld * SLOW_DOWN_SPACING_MS;
  slowDownHeld += 1;
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(signal!.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', stop);
        resolve();
      }, wait);
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
    });
  } finally {
    slowDownHeld -= 1;
  }
}

/** The refusal for a response the service did not accept; a slow-down is remembered for every other call. */
function refusedBy(status: number, body: string): PuterHttpError {
  const error = new PuterHttpError(status, body);
  noteSlowDown(error);
  return error;
}

/** The HTTP error status a refusal names for itself (`status`, or a numeric `code`); null when it names none. */
function statusNamedIn(refusal: unknown): number | null {
  if (!refusal || typeof refusal !== 'object') return null;
  const { status, code } = refusal as { status?: unknown; code?: unknown };
  for (const value of [status, code]) {
    const named = typeof value === 'number' ? value : typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : NaN;
    if (named >= 400 && named <= 599) return named;
  }
  return null;
}

/**
 * A refusal the service sent inside a 200 reply: `{ success: false, error }`
 * as the whole body, or an error line in a stream. It keeps the status it
 * names (a rate limit stays a 429, so it is waited out, not treated as a
 * rejected request); one that names none is a bad gateway.
 */
function refusedInside(reply: { error?: unknown }): PuterHttpError {
  const refusal = reply.error && typeof reply.error === 'object' ? reply.error : reply;
  return refusedBy(statusNamedIn(refusal) ?? statusNamedIn(reply) ?? 502, JSON.stringify(refusal));
}

// ── Tools as text, for a route that drops native tool calls ──────────────

/**
 * The tool exchanges rewritten as plain text. Some free routes refuse
 * `tool`-role messages or assistant tool calls in the history outright;
 * the same facts as text get the same model to carry on.
 */
export function toolHistoryAsText(messages: PuterMessage[]): PuterMessage[] {
  const names = new Map<string, string>();
  const out: PuterMessage[] = [];
  const pushUser = (text: string) => {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') last.content = `${last.content}\n\n${text}`;
    else out.push({ role: 'user', content: text });
  };
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) names.set(call.id, call.function.name);
      const calls = message.tool_calls.map((call) => `[Called ${call.function.name} ${call.function.arguments || '{}'}]`).join('\n');
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      out.push({ role: 'assistant', content: text ? `${text}\n\n${calls}` : calls });
    } else if (message.role === 'tool') {
      pushUser(`[${names.get(message.tool_call_id ?? '') ?? 'Tool'} result]\n${typeof message.content === 'string' ? message.content : ''}`);
    } else if (message.role === 'user' && typeof message.content === 'string') {
      pushUser(message.content);
    } else {
      out.push(message);
    }
  }
  return out;
}

function textToolGuide(tools: PuterTool[]): string {
  const list = tools
    .map((tool) => `- ${tool.function.name}: ${tool.function.description}\n  arguments (JSON Schema): ${JSON.stringify(tool.function.parameters)}`)
    .join('\n');
  return [
    'You can use the tools below. To call one, write exactly:',
    '<tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>',
    'You may write several tool calls in one reply. Then stop: each result comes back in the next message as "[TOOL_NAME result]". Call a tool only when you need it; otherwise answer normally.',
    '',
    list,
  ].join('\n');
}

/** The conversation for a text-tools route: tool turns as text, and the tools explained in the system message. */
function textToolMessages(messages: PuterMessage[], tools: PuterTool[]): PuterMessage[] {
  const flat = toolHistoryAsText(messages);
  const guide = textToolGuide(tools);
  const first = flat[0];
  if (first?.role === 'system' && typeof first.content === 'string') return [{ ...first, content: `${first.content}\n\n${guide}` }, ...flat.slice(1)];
  return [{ role: 'system', content: guide }, ...flat];
}

const PYTHON_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', '/': '/' };

/** A quoted literal's text, its escapes read as Python reads them (an unknown one keeps its backslash, as in `\d`). */
function pythonString(literal: string): string {
  return literal.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (escape, code: string) =>
    code.length > 1 ? String.fromCharCode(parseInt(code.slice(1), 16)) : Object.hasOwn(PYTHON_ESCAPES, code) ? PYTHON_ESCAPES[code]! : escape);
}

/** `query="x", count=5`: a Python-style argument list of plain literals; null when it is anything else. */
function parseKeywordArgs(source: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const src = source.trim();
  const pattern = /\s*([A-Za-z_]\w*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false|True|False|None|null)\s*(?:,|$)/y;
  let at = 0;
  while (at < src.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(src);
    if (!match) return null;
    const literal = match[2]!;
    let value: unknown;
    if (literal.startsWith('"') || literal.startsWith("'")) value = pythonString(literal);
    else if (/^(true|True)$/.test(literal)) value = true;
    else if (/^(false|False)$/.test(literal)) value = false;
    else if (/^(None|null)$/.test(literal)) value = null;
    else value = Number(literal);
    out[match[1]!] = value;
    at = pattern.lastIndex;
  }
  return out;
}

/** Whether a reply looks like it holds a tool call written as text (worth parsing). */
export function mayHoldTextToolCalls(text: string): boolean {
  return /<\/?tool_call>|^\[Called [\w.-]+ \{/m.test(text);
}

/**
 * Tool calls a model wrote as text: <tool_call>{"name", "arguments"}</tool_call>
 * blocks, the Python-style `Name(arg="v") </tool_call>` some routed models
 * write, and the "[Called name {...}]" lines the text history shows. Only
 * tools it was given count; everything else stays in the reply.
 */
export function parseTextToolCalls(text: string, toolNames: readonly string[]): { text: string; calls: Array<{ name: string; input: Record<string, unknown> }> } {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const takeCall = (raw: string): boolean => {
    const call = /^\s*([A-Za-z_][\w.-]*)\s*\(([\s\S]*)\)\s*$/.exec(raw);
    if (!call || !toolNames.includes(call[1]!)) return false;
    try {
      const args = parseKeywordArgs(call[2]!);
      if (!args) return false;
      calls.push({ name: call[1]!, input: args });
      return true;
    } catch {
      return false;
    }
  };
  const take = (raw: string): boolean => {
    const json = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      const parsed = JSON.parse(json) as { name?: unknown; arguments?: unknown; parameters?: unknown; input?: unknown };
      if (typeof parsed.name !== 'string' || !toolNames.includes(parsed.name)) return false;
      let args: unknown = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
      if (typeof args === 'string') args = JSON.parse(args);
      calls.push({ name: parsed.name, input: args && typeof args === 'object' ? args as Record<string, unknown> : {} });
      return true;
    } catch {
      return takeCall(json);
    }
  };
  let rest = text.replace(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g, (block, inner: string) => (take(inner) ? '' : block));
  // A call with only the closing tag after it, one per line.
  rest = rest.replace(/^[ \t]*([A-Za-z_][\w.-]*\([^\n]*\))[ \t]*<\/tool_call>[ \t]*$/gm, (line, call: string) => (takeCall(call) ? '' : line));
  rest = rest.replace(/^\[Called ([\w.-]+) (\{[\s\S]*?\})\]\s*$/gm, (line, name: string, args: string) => {
    try {
      return take(JSON.stringify({ name, arguments: JSON.parse(args) as unknown })) ? '' : line;
    } catch {
      return line;
    }
  });
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), calls };
}

/** Thinking a model wrote inline as <thought>…</thought> (Gemma on Google's route), split from the answer. */
function splitThoughtTags(text: string): { thinking: string; answer: string } {
  const thoughts: string[] = [];
  const answer = text.replace(/<thought>([\s\S]*?)(?:<\/thought>|$)/gi, (_, inner: string) => {
    thoughts.push(inner.trim());
    return '';
  });
  return { thinking: thoughts.join('\n\n'), answer: answer.trim() };
}

// How long a call waits on the service: a one-shot reply in all, a stream for each next piece.
const CALL_LIMIT_MS = 180_000;
const STREAM_QUIET_MS = 300_000;

/** The error AbortSignal.timeout gives, so callers treat it as a busy model that may answer on a retry. */
function timedOut(ms: number): DOMException {
  return new DOMException(`The free model sent nothing for ${ms / 60_000} minutes, so Automa stopped waiting. Send the message again in a minute.`, 'TimeoutError');
}

/** The caller's signal, also ended `ms` from now unless cleared first: a caller's signal alone never times out. */
function withDeadline(ms: number, signal?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(timedOut(ms)), ms);
  return { signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal, clear: () => clearTimeout(timer) };
}

/** The stream's next piece, or a TimeoutError once it has sent nothing for `ms`. */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut(ms)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** `queueKey`: the model the call waits in line as (Automa's id, the same one a stream of it waits as). */
async function driverCall(body: Record<string, unknown>, token: string, signal?: AbortSignal, queueKey?: string): Promise<unknown> {
  const model = (body.args as { model?: unknown } | undefined)?.model;
  const release = await queTurn(signal, queueKey ?? (typeof model === 'string' ? model : undefined));
  try {
    await waitOutSlowDown(signal);
  } catch (stopped) {
    release();
    throw stopped;
  }
  const appUid = nextAppUid();
  const deadline = withDeadline(CALL_LIMIT_MS, signal);
  try {
    const r = await fetch(PUTER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;actually=json' },
      body: JSON.stringify({ ...body, auth_token: token, app_uid: appUid }),
      signal: deadline.signal,
    });
    if (!r.ok) {
      const refused = refusedBy(r.status, await r.text().catch(() => ''));
      // A busy app id rests and others take over; the service's own limit is on the install, not the app id.
      if (r.status === 429 && !refused.slowDown) { cooldownAppUid(appUid); spawnAppIds(20); }
      throw refused;
    }
    const d = await r.json() as { success?: boolean; result?: unknown; error?: unknown };
    if (d.success === false) throw refusedInside(d);
    return d.result;
  } finally {
    deadline.clear();
    release();
  }
}

async function callChat(
  messages: PuterMessage[],
  model: string,
  token: string,
  signal: AbortSignal | undefined,
  queueKey: string,
): Promise<{ text: string; reasoning: string; usage: PuterUsage; costCents: number }> {
  const result = await driverCall(
    { interface: 'puter-chat-completion', driver: 'ai-chat', method: 'complete', args: { messages, model } },
    token,
    signal,
    queueKey,
  ) as {
    message?: { content?: unknown; reasoning?: unknown };
    usage?: { prompt?: number; completion?: number; usd_cents?: number };
    usageDetails?: { inputTokens?: number; outputTokens?: number };
  } | undefined;
  const usage = {
    inputTokens: Number(result?.usageDetails?.inputTokens ?? result?.usage?.prompt ?? 0) || 0,
    outputTokens: Number(result?.usageDetails?.outputTokens ?? result?.usage?.completion ?? 0) || 0,
  };
  const costCents = Number(result?.usage?.usd_cents ?? 0) || 0;
  const reasoning = typeof result?.message?.reasoning === 'string' ? result.message.reasoning : '';
  const content = result?.message?.content;
  if (typeof content === 'string') return { text: content, reasoning, usage, costCents };
  if (Array.isArray(content)) {
    const text = content.map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? '')).join('');
    return { text, reasoning, usage, costCents };
  }
  return { text: '', reasoning, usage, costCents };
}

/** The router handed the request to the safety classifier instead of a chat model. */
function isSafetyVerdict(text: string): boolean {
  return /^\s*user safety:/i.test(text);
}

/**
 * Chat on the chosen model, retrying it (never another model) when the
 * provider is busy. A Gemma whose main route is out (busy, at its daily
 * limit, closed or taken offline) is asked over Google's route.
 */
export async function puterComplete(
  messages: PuterMessage[],
  opts: PuterChatOptions = {},
): Promise<{ text: string; reasoning: string; model: string; usage: PuterUsage }> {
  const token = resolveToken(opts.token);
  const appId = appModelId(opts.model);
  const model = resolveModel(opts.model);
  const backup = PUTER_BACKUP_ROUTES[appId];
  const retries = Math.max(1, opts.retries ?? 3);
  let lastError: unknown;
  const spent: PuterUsage = { inputTokens: 0, outputTokens: 0 };
  let sent = 0;
  /** One try: the model's one route, or for a model with two, the routes that are not out, in turn. */
  const ask = async (): Promise<{ reply: Awaited<ReturnType<typeof callChat>>; onBackup: boolean }> => {
    if (!backup) {
      sent += 1;
      try {
        return { reply: await callChat(messages, model, token, opts.signal, appId), onBackup: false };
      } catch (e) {
        if (e instanceof PuterHttpError && !opts.signal?.aborted) noteRefusal(appId, e);
        throw e;
      }
    }
    const round = routeRound(appId);
    for (const route of round.plan) {
      const onBackup = route === 'backup';
      sent += 1;
      try {
        const reply = await callChat(onBackup ? toolHistoryAsText(messages) : messages, onBackup ? backup.model : model, token, opts.signal, appId);
        round.answered(route);
        return { reply, onBackup };
      } catch (e) {
        if (opts.signal?.aborted || !round.failed(route, e)) throw e;
      }
    }
    throw round.refusal();
  };
  // The first move from a route that is out to the model's other route is not a retry; every call after it is.
  let freeMoves = backup ? 1 : 0;
  for (let i = 0; i < retries; i++) {
    // Held before the first try, or since the last one (it charged, or reached its daily limit).
    const held = heldRefusal(appId);
    if (held) throw held;
    const before = sent;
    try {
      const { reply, onBackup } = await ask();
      spent.inputTokens += reply.usage.inputTokens;
      spent.outputTokens += reply.usage.outputTokens;
      if (reply.costCents > 0) noteCharged(appId, reply.costCents);
      const split = onBackup ? splitThoughtTags(reply.text) : { thinking: '', answer: reply.text };
      const text = split.answer;
      const reasoning = reply.reasoning || split.thinking;
      if (appId === FREE_ROUTER_ID && isSafetyVerdict(text)) {
        lastError = new Error('The Free Router answered with a safety verdict instead of a reply.');
      } else if (text.trim() || reasoning.trim()) {
        // Whichever route delivered it, the model answered.
        if (reply.costCents <= 0) noteAnswered(appId);
        return { text, reasoning, model: appId, usage: spent };
      } else {
        lastError = new Error(`${appId} returned an empty reply`);
      }
    } catch (e) {
      lastError = e;
      if (opts.signal?.aborted) throw e;
      if (!isTransientPuterError(e)) throw e;
    }
    const moves = Math.max(0, sent - before - 1);
    const free = Math.min(moves, freeMoves);
    freeMoves -= free;
    i += moves - free;
    if (i + 1 < retries) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error('The free model is busy. Try again in a minute.');
}

/** One-shot chat. */
export async function puterChat(prompt: string | PuterMessage[], opts: PuterChatOptions = {}): Promise<string> {
  const messages = typeof prompt === 'string' ? [{ role: 'user' as const, content: prompt }] : prompt;
  return (await puterComplete(messages, opts)).text;
}

const convos: Record<string, { messages: PuterMessage[]; model: string }> = {};

/** Multi-turn conversation kept in process memory. */
export async function puterConvo(prompt: string, id = 'default', opts: PuterConvoOptions = {}): Promise<string> {
  if (!convos[id]) {
    resolveModel(opts.model);
    // Automa's id, not the service route: the route is not on the free list it is checked against.
    convos[id] = { messages: [], model: appModelId(opts.model) };
  }
  const c = convos[id];
  if (opts.system && !c.messages.some((m) => m.role === 'system')) {
    c.messages.unshift({ role: 'system', content: opts.system });
  }
  c.messages.push({ role: 'user', content: prompt });
  let text: string;
  try {
    ({ text } = await puterComplete(c.messages, { ...opts, model: c.model }));
  } catch (error) {
    // No unanswered turn left behind: strict providers refuse two user turns in a row.
    c.messages.pop();
    throw error;
  }
  c.messages.push({ role: 'assistant', content: text });
  return text;
}

/** Parallel one-shot prompts; null where a prompt failed. */
export async function puterBatch(prompts: string[], opts: PuterChatOptions = {}): Promise<(string | null)[]> {
  const results = await Promise.allSettled(prompts.map((p) => puterChat(p, opts)));
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null));
}

export function puterClearConvo(id = 'default'): void {
  delete convos[id];
}

/** First chat model carrying `tag` (e.g. "code", "fast", "vision"), else the default model. */
export function puterPickModel(tag: string): PuterModelId {
  for (const [key, meta] of Object.entries(PUTER_MODEL_META)) {
    if (meta.tags.includes(tag)) return PUTER_MODELS[key as PuterModelKey];
  }
  return PUTER_DEFAULT_MODEL;
}

/** Text-to-image. Resolves to the image bytes and its MIME type. */
const PUTER_USAGE_API = 'https://api.puter.com/metering/usage';
const ALLOWANCE_CACHE_MS = 62_000;

/** The free-model service's monthly allowance, and this month's requests to each of Automa's free models. */
export interface FreeModelAllowance {
  /** The month's allowance and what is left of it, in the service's own unit. */
  allowance: number;
  remaining: number;
  unit: string;
  /** Requests this month by Automa model id; only Automa's free models are listed. */
  requestsByModel: Partial<Record<PuterModelId, number>>;
  checkedAt: string;
}

let allowanceCache: { at: number; value: FreeModelAllowance } | null = null;

/** Automa's model id for a usage entry's route ("openrouter:qwen/qwen3_dot_8-27b:free"), or null when it is not one of them. */
function usageRouteModel(route: string): PuterModelId | null {
  const name = route.replaceAll('_dot_', '.');
  // Without the provider the service routed it through ("openrouter:", "infron:").
  const bare = name.replace(/^[\w.-]+:/, '');
  for (const id of PUTER_MODEL_LIST) {
    if (id === name || id === bare || PUTER_ROUTES[id] === name || PUTER_ROUTES[id] === bare || PUTER_BACKUP_ROUTES[id]?.model === bare) return id;
  }
  return null;
}

/**
 * Reads the service's usage report: the month's allowance and what is left,
 * and how many requests each free model got this month. The report covers
 * every Automa user, as they share the allowance. Kept for a minute.
 */
export async function freeModelAllowance(signal?: AbortSignal): Promise<FreeModelAllowance> {
  if (allowanceCache && Date.now() - allowanceCache.at < ALLOWANCE_CACHE_MS) return allowanceCache.value;
  const deadline = withDeadline(15_000, signal);
  try {
    const r = await fetch(PUTER_USAGE_API, { headers: { Authorization: `Bearer ${resolveToken()}` }, signal: deadline.signal });
    if (!r.ok) throw new PuterHttpError(r.status, await r.text().catch(() => ''));
    const data = await r.json() as {
      usage?: Record<string, unknown>;
      allowanceInfo?: { monthUsageAllowance?: unknown; remaining?: unknown; unit?: unknown };
    };
    const allowance = Number(data.allowanceInfo?.monthUsageAllowance);
    const remaining = Number(data.allowanceInfo?.remaining);
    if (!Number.isFinite(allowance) || !Number.isFinite(remaining)) throw new PuterHttpError(502, 'The usage report has no allowance.');
    const counted: Partial<Record<PuterModelId, { requests: number; calls: number }>> = {};
    for (const [key, value] of Object.entries(data.usage ?? {})) {
      const at = key.lastIndexOf(':');
      if (at <= 0 || !value || typeof value !== 'object') continue;
      const model = usageRouteModel(key.slice(0, at));
      const count = Number((value as { count?: unknown }).count);
      if (!model || !Number.isFinite(count)) continue;
      const entry = (counted[model] ??= { requests: 0, calls: 0 });
      // One "request" entry per call where the route reports it; else the most-counted entry stands for the calls.
      if (key.slice(at + 1) === 'request') entry.requests += count;
      else entry.calls = Math.max(entry.calls, count);
    }
    const requestsByModel: Partial<Record<PuterModelId, number>> = {};
    for (const [model, entry] of Object.entries(counted) as Array<[PuterModelId, { requests: number; calls: number }]>) {
      requestsByModel[model] = entry.requests || entry.calls;
    }
    const value: FreeModelAllowance = {
      allowance,
      remaining: Math.max(0, remaining),
      unit: typeof data.allowanceInfo?.unit === 'string' && data.allowanceInfo.unit ? data.allowanceInfo.unit : 'credits',
      requestsByModel,
      checkedAt: new Date().toISOString(),
    };
    allowanceCache = { at: Date.now(), value };
    return value;
  } finally {
    deadline.clear();
  }
}

/** Forgets the cached usage report (tests). */
export function resetFreeModelAllowance(): void {
  allowanceCache = null;
}

export async function puterImage(
  prompt: string,
  opts: PuterImageOptions = {},
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string; model: PuterImageModelId }> {
  const model = resolveImageModel(opts.model);
  const args: Record<string, unknown> = { prompt, model };
  if (opts.inputImage) args.input_image = opts.inputImage;
  if (opts.maskImage) args.mask_image = opts.maskImage;
  const result = await driverCall(
    { interface: 'puter-image-generation', driver: 'ai-image', method: 'generate', args },
    resolveToken(opts.token),
    opts.signal,
  );
  const dataUrl = typeof result === 'string' ? result : '';
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match || !match[2]) throw new Error(`${model} returned no image`);
  const bytes = Uint8Array.from(atob(match[3]!), (ch) => ch.charCodeAt(0));
  // Puter labels every image image/png; sniff the real format so uploads get the right type.
  const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : (match[1] ?? 'image/png');
  return { bytes, mimeType, model };
}

export interface PuterStreamOptions {
  model?: string;
  tools?: PuterTool[];
  token?: string;
  signal?: AbortSignal;
}

/**
 * One streamed chat call: text and reasoning arrive in pieces, a tool call
 * arrives whole, and the last event carries the usage. Throws PuterHttpError
 * (with its status and `kind`) when the call is refused, so callers can retry
 * or say why. Always the chosen model: a Gemma whose main route is out (busy,
 * at its daily limit, closed or taken offline) is asked over Google's route
 * (tools as text there), and the Free Router is asked again when it hands the
 * request to the safety classifier. The call waits its turn in the Que
 * engine's queue and holds it until the stream ends.
 */
export async function* puterStream(messages: PuterMessage[], opts: PuterStreamOptions = {}): AsyncGenerator<PuterStreamEvent> {
  // An unknown or held model fails at once instead of waiting in line first.
  resolveModel(opts.model);
  const held = heldRefusal(appModelId(opts.model));
  if (held) throw held;
  const release = await queTurn(opts.signal, appModelId(opts.model));
  // Each piece that arrives restarts the queue's safety timer, so a long live stream keeps its turn.
  const { refresh } = release as QueRelease & { refresh?: unknown };
  const keepTurn = () => {
    if (typeof refresh === 'function') refresh.call(release);
  };
  try {
    yield* streamTurn(messages, opts, keepTurn);
  } finally {
    release();
  }
}

async function* streamTurn(messages: PuterMessage[], opts: PuterStreamOptions, keepTurn: () => void): AsyncGenerator<PuterStreamEvent> {
  const appId = appModelId(opts.model);
  const primary = resolveModel(opts.model);
  const held = heldRefusal(appId);
  if (held) throw held;
  const token = resolveToken(opts.token);
  const tools = opts.tools?.length ? opts.tools : undefined;
  const backup = PUTER_BACKUP_ROUTES[appId];

  const open = async (model: string, sent: PuterMessage[], withTools?: PuterTool[]) => {
    await waitOutSlowDown(opts.signal);
    const appUid = nextAppUid();
    const deadline = withDeadline(STREAM_QUIET_MS, opts.signal);
    try {
      const response = await fetch(PUTER_API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;actually=json' },
        body: JSON.stringify({
          interface: 'puter-chat-completion',
          driver: 'ai-chat',
          method: 'complete',
          args: { messages: sent, model, stream: true, ...(withTools ? { tools: withTools } : {}) },
          auth_token: token,
          app_uid: appUid,
        }),
        signal: deadline.signal,
      });
      if (!response.ok || !response.body) {
        const refused = refusedBy(response.status, await response.text().catch(() => ''));
        if (response.status === 429 && !refused.slowDown) { cooldownAppUid(appUid); spawnAppIds(20); }
        throw refused;
      }
      if (!(response.headers.get('content-type') ?? '').includes('ndjson')) {
        const body = await response.text();
        const parsed = (() => { try { return JSON.parse(body) as { success?: boolean; error?: unknown } | null; } catch { return null; } })();
        // A refusal sent as a 200: it keeps the status it names (a rate limit stays one), else it is a bad gateway.
        if (parsed && typeof parsed === 'object' && (parsed.success === false || parsed.error)) throw refusedInside(parsed);
        throw new PuterHttpError(502, body);
      }
      return response.body.getReader();
    } finally {
      deadline.clear();
    }
  };

  if (backup) {
    // A model with two routes: the main one unless it is out, then the second. Still the same model.
    const round = routeRound(appId);
    for (const route of round.plan) {
      // Once part of a reply has reached the caller it is too late to start over on the other route.
      let delivered = false;
      try {
        if (route === 'main') {
          const reader = await open(primary, messages, tools);
          round.answered(route);
          for await (const event of readStream(reader, appId, keepTurn)) {
            delivered = true;
            yield event;
          }
          return;
        }
        // Google's route: the whole reply, then its inline thinking and any tool calls written as text.
        const sent = tools && backup.toolsAsText ? textToolMessages(messages, tools) : toolHistoryAsText(messages);
        const reader = await open(backup.model, sent, tools && !backup.toolsAsText ? tools : undefined);
        let text = '';
        let reasoning = '';
        let done: Extract<PuterStreamEvent, { type: 'done' }> | null = null;
        for await (const event of readStream(reader, appId, keepTurn)) {
          if (event.type === 'text') text += event.text;
          else if (event.type === 'reasoning') reasoning += event.text;
          else if (event.type === 'done') done = event;
        }
        round.answered(route);
        delivered = true;
        const split = splitThoughtTags(text);
        const parsed = tools && backup.toolsAsText ? parseTextToolCalls(split.answer, tools.map((tool) => tool.function.name)) : { text: split.answer, calls: [] };
        const thinking = [reasoning.trim(), split.thinking].filter(Boolean).join('\n\n');
        if (thinking) yield { type: 'reasoning', text: thinking };
        if (parsed.text) yield { type: 'text', text: parsed.text };
        for (const call of parsed.calls) yield { type: 'tool_use', id: `call_${Math.random().toString(36).slice(2)}`, name: call.name, input: call.input };
        yield {
          type: 'done',
          usage: done?.usage ?? { inputTokens: 0, outputTokens: 0 },
          stopReason: parsed.calls.length ? 'tool_use' : (done?.stopReason ?? 'end_turn'),
        };
        return;
      } catch (error) {
        if (opts.signal?.aborted || !round.failed(route, error)) throw error;
        if (delivered) {
          if (error instanceof PuterHttpError) noteRefusal(appId, error);
          throw error;
        }
      }
    }
    throw round.refusal();
  }

  // One route. What it refuses with is the model's state, whether the refusal comes in place of the stream or inside it.
  const noted = (error: unknown): unknown => {
    if (error instanceof PuterHttpError && !opts.signal?.aborted) noteRefusal(appId, error);
    return error;
  };
  const openMain = async () => {
    try {
      return await open(primary, messages, tools);
    } catch (error) {
      throw noted(error);
    }
  };
  const read = async function* (reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<PuterStreamEvent> {
    try {
      yield* readStream(reader, appId, keepTurn);
    } catch (error) {
      throw noted(error);
    }
  };

  let reader = await openMain();
  if (appId !== FREE_ROUTER_ID) {
    yield* read(reader);
    return;
  }
  // The Free Router: hold the first words back until it is clear a chat model answered.
  for (let attempt = 1; ; attempt += 1) {
    const held: PuterStreamEvent[] = [];
    let head = '';
    let decided = false;
    let verdict = false;
    for await (const event of read(reader)) {
      if (decided) {
        yield event;
        continue;
      }
      held.push(event);
      if (event.type === 'text') head += event.text;
      if (head.trim().length >= 16 || event.type === 'tool_use' || event.type === 'done') {
        decided = true;
        verdict = isSafetyVerdict(head);
        if (verdict) break;
        yield* held;
      }
    }
    if (!decided) yield* held;
    if (!verdict) return;
    if (attempt >= 3) {
      throw new PuterHttpError(503, JSON.stringify({ error: 'The Free Router kept handing the request to the safety classifier' }), { kind: 'busy', retryAfterMs: null });
    }
    reader = await openMain();
  }
}

/**
 * The events in one stream. Its usage line says the model answered (over
 * whichever of its routes), or that it charged. An error line is thrown as
 * the refusal it is. `onPiece` runs as each piece arrives.
 */
async function* readStream(reader: ReadableStreamDefaultReader<Uint8Array>, appId: string, onPiece: () => void): AsyncGenerator<PuterStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  const parse = (line: string): PuterStreamEvent | null => {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
    if (event.type === 'text' && typeof event.text === 'string') return { type: 'text', text: event.text };
    if (event.type === 'reasoning' && typeof event.reasoning === 'string') return { type: 'reasoning', text: event.reasoning };
    if (event.type === 'tool_use' && typeof event.name === 'string') {
      return { type: 'tool_use', id: typeof event.id === 'string' ? event.id : `call_${Math.random().toString(36).slice(2)}`, name: event.name, input: event.input ?? {} };
    }
    if (event.type === 'usage') {
      const usage = event.usageDetails as { inputTokens?: number; outputTokens?: number } | undefined;
      const raw = event.usage as { prompt?: number; completion?: number; usd_cents?: number } | undefined;
      const cents = Number(raw?.usd_cents ?? 0) || 0;
      if (cents > 0) noteCharged(appId, cents);
      else noteAnswered(appId);
      return {
        type: 'done',
        usage: { inputTokens: Number(usage?.inputTokens ?? raw?.prompt ?? 0) || 0, outputTokens: Number(usage?.outputTokens ?? raw?.completion ?? 0) || 0 },
        stopReason: typeof event.stopReason === 'string' ? event.stopReason : 'end_turn',
      };
    }
    // A refusal sent as a line of the stream, in either shape the service uses.
    if (event.type === 'error' || event.success === false || event.error) throw refusedInside(event);
    return null;
  };
  let ended = false;
  try {
    while (true) {
      const { done, value } = await readWithin(reader, STREAM_QUIET_MS);
      if (done) break;
      onPiece();
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        const event = parse(line);
        if (!event) continue;
        if (event.type === 'done') finished = true;
        yield event;
      }
    }
    ended = true;
  } finally {
    // Left early (the caller stopped reading, the stream sent an error or went quiet): end the call upstream too.
    if (!ended) await reader.cancel().catch(() => undefined);
  }
  const tail = buffer.trim();
  if (tail) {
    const event = parse(tail);
    if (event) {
      if (event.type === 'done') finished = true;
      yield event;
    }
  }
  if (!finished) yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' };
}
