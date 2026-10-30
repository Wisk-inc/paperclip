/**
 * Free models via Puter (chat + image). Server-only: import from
 * "@paperclipai/shared/puter-ai" so the embedded token never ships in the web bundle.
 */
import type { FreeModelHealthEntry, FreeModelState } from './free-models.js';
import { queTurn, type QueRelease } from './que-queue.js';

const _P = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6Ik',
  'pXVCIsImtpZCI6InYyIn0.eyJ0Ijoi',
  'YXUiLCJ2IjoiMiIsInV1IjoiKzhRaU',
  'wrRkFUb3ltbFgxdUkvM2Urdz09Iiwi',
  'YXUiOiJFTG9sTEZJRFdGRzJWN05adF',
  'NVRitRPT0iLCJzdSI6IlhFNVB6OEhB',
  'UVFDNjlFcXpMZGtkQnc9PSIsImFpIj',
  'oiKzhRaUwrRkFUb3ltbFgxdUkvM2Ur',
  'dz09IiwiaWF0IjoxNzkyOTkzOTEzfQ',
  '.BDd0t_So16lMJykP-ERM3-Pcj7g3G',
  '63BgkHJ_DREHGk',
];
const EMBEDDED_TOKEN = _P.join('');

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
  'xing4':                   'xingchen-agi/xing4.0-29b-a4b:free',
  'bonsai-27b':              'prism-ml/ternary-bonsai-27b:free',
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
  'xing4':                   { label: 'Xing 4.0 29B A4B', context: 262_000, tags: [] },
  'bonsai-27b':              { label: 'Ternary Bonsai 27B', context: 262_000, tags: [] },
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
 * The same model on a second free route, tried when the first is busy:
 * Google serves Gemma 4 free as well as OpenRouter does. Google's route
 * drops native tool calls, so tools travel over it as text.
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

const appIds: string[] = Array.from({ length: 200 }, () => 'px-' + crypto.randomUUID());
const appCooldown = new Map<string, number>();
let appIdx = 0;

function spawnAppIds(count = 50): void {
  for (let i = 0; i < count; i++) appIds.push('px-' + crypto.randomUUID());
}

function nextAppUid(): string {
  const now = Date.now();
  for (let tries = 0; tries < appIds.length; tries++) {
    appIdx = (appIdx + 1) % appIds.length;
    const id = appIds[appIdx]!;
    const cd = appCooldown.get(id);
    if (!cd || now > cd) { appCooldown.delete(id); return id; }
  }
  spawnAppIds(50);
  appIdx = appIds.length - 1;
  return appIds[appIdx]!;
}

function cooldownAppUid(id: string): void {
  appCooldown.set(id, Date.now() + 11_000);
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
    throw new Error(`"${id}" is not one of Automa's free models. Pick a model from the free list in the switcher.`);
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
 * - busy: rate-limited or overloaded for now; retry, or try the model's backup route
 * - restricted: the provider only lets certain apps use the model
 * - withdrawn: the provider took the free version offline
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

function classifyRefusal(status: number, code: string | null, body: string): { kind: PuterRefusalKind; retryAfterMs: number | null } {
  const text = body.toLowerCase();
  if (/daily limit|requests per day/.test(text)) {
    const seconds = /try again (?:after|in) (\d+)/.exec(text)?.[1];
    return { kind: 'daily_limit', retryAfterMs: seconds ? Number(seconds) * 1000 : msUntilUtcMidnight() };
  }
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
 * A refused call. `code` and `upstream` are read out of the service's JSON
 * (for example `upstream_provider_unavailable` with the provider's own
 * message), and `kind` says what the refusal means for the next step.
 */
export class PuterHttpError extends Error {
  readonly code: string | null;
  readonly upstream: string | null;
  readonly kind: PuterRefusalKind;
  /** For a daily limit: how long until the model answers again. */
  readonly retryAfterMs: number | null;
  constructor(readonly status: number, readonly body: string, held?: { kind: PuterRefusalKind; retryAfterMs: number | null }) {
    body = hideToken(body);
    super(`Free model service answered ${status}: ${body.slice(0, 300)}`);
    let code: string | null = null;
    let upstream: string | null = null;
    try {
      const parsed = JSON.parse(body) as {
        code?: unknown; message?: unknown; error?: unknown;
        attempts?: Array<{ status?: unknown; error?: unknown; upstreamMessage?: unknown }>;
      };
      if (typeof parsed.code === 'string') code = parsed.code;
      const attempt = Array.isArray(parsed.attempts) ? parsed.attempts[0] : undefined;
      const detail = [attempt?.upstreamMessage, attempt?.error, parsed.message, parsed.error].find((v) => typeof v === 'string' && v.trim());
      if (typeof detail === 'string') upstream = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch {
      // Not JSON: the body is the message.
      if (body.trim() && body.length < 200) upstream = body.trim();
    }
    this.code = code;
    this.upstream = upstream;
    const classified = held ?? classifyRefusal(status, code, body);
    this.kind = classified.kind;
    this.retryAfterMs = classified.retryAfterMs;
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
      return new Error(`${modelLabel} has used up today's free requests. The provider shares that daily limit across everyone who uses it free, so it isn't anything you did. It's back ${backIn(error.retryAfterMs)}. To keep going now, pick another model in the switcher.`);
    case 'restricted':
      return new Error(`${modelLabel}'s provider only lets certain partner apps use it right now, so it can't answer through Automa's free service. Automa checks again with your next message (every few minutes at most), and it answers as soon as the provider opens it up.`);
    case 'withdrawn':
      return new Error(`${modelLabel}'s free version was taken offline by its provider. Automa checks again with your next message (every few minutes at most), and it answers as soon as the provider brings it back.`);
    case 'charged':
      return new Error(`${modelLabel} started charging for requests, so Automa stopped calling it to keep the free models free for everyone. It's tried again in a few hours.`);
    default: {
      const why = error.kind === 'busy'
        ? error.code === 'upstream_provider_unavailable'
          ? `could not be reached${error.upstream ? ` (${error.upstream})` : ''}`
          : error.status >= 500 ? `had a server error (${error.status})` : 'is busy at its provider right now'
        : `rejected the request${error.upstream ? `: ${error.upstream}` : ` (${error.status})`}`;
      const tried = retries > 0 ? ` Automa stayed on this model and retried ${retries} time${retries === 1 ? '' : 's'}.` : '';
      return new Error(`${modelLabel} ${why}.${tried} Send the message again in a minute, or pick a different model in the switcher if it keeps happening.`);
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

function noteRefusal(model: string, error: PuterHttpError) {
  const state: FreeModelState | null = error.kind === 'daily_limit' || error.kind === 'busy' || error.kind === 'restricted' || error.kind === 'withdrawn' || error.kind === 'charged'
    ? error.kind
    : null;
  if (!state) return;
  const now = Date.now();
  const until = state === 'daily_limit' ? now + (error.retryAfterMs ?? msUntilUtcMidnight(now)) : now + HOLD_MS[state];
  health.set(model, { state, until, checkedAt: now, status: error.status, body: error.body });
}

function noteAnswered(model: string) {
  health.set(model, { state: 'ok', until: 0, checkedAt: Date.now(), status: 200, body: '' });
}

function noteCharged(model: string, cents: number) {
  noteRefusal(model, new PuterHttpError(402, JSON.stringify({ error: `${model} charged the shared allowance (${cents} cents)` })));
}

/** The standing refusal for a model that is held (not busy: busy models are still tried). */
function heldRefusal(model: string): PuterHttpError | null {
  const entry = health.get(model);
  if (!entry || entry.state === 'ok' || entry.state === 'busy') return null;
  const left = entry.until - Date.now();
  if (left <= 0) return null;
  return new PuterHttpError(entry.status, entry.body, { kind: entry.state, retryAfterMs: entry.state === 'daily_limit' ? left : null });
}

function isBusy(model: string): boolean {
  const entry = health.get(model);
  return Boolean(entry && entry.state === 'busy' && entry.until > Date.now());
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
    };
  }
  return out;
}

/** Forgets every model's state (tests). */
export function resetFreeModelHealth(): void {
  health.clear();
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
      if (r.status === 429) { cooldownAppUid(appUid); spawnAppIds(20); }
      throw new PuterHttpError(r.status, await r.text().catch(() => ''));
    }
    const d = await r.json() as { success?: boolean; result?: unknown; error?: unknown };
    if (d.success === false) throw new PuterHttpError(502, JSON.stringify(d.error ?? d));
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
 * provider is busy; a busy Gemma is asked again over Google's route.
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
  for (let i = 0; i < retries; i++) {
    // Held before the first try, or since the last one (it charged, or reached its daily limit).
    const held = heldRefusal(appId);
    if (held) throw held;
    const onBackup = Boolean(backup && isBusy(appId));
    try {
      const reply = await callChat(onBackup ? toolHistoryAsText(messages) : messages, onBackup ? backup!.model : model, token, opts.signal, appId);
      spent.inputTokens += reply.usage.inputTokens;
      spent.outputTokens += reply.usage.outputTokens;
      if (reply.costCents > 0) noteCharged(appId, reply.costCents);
      const split = onBackup ? splitThoughtTags(reply.text) : { thinking: '', answer: reply.text };
      const text = split.answer;
      const reasoning = reply.reasoning || split.thinking;
      if (appId === FREE_ROUTER_ID && isSafetyVerdict(text)) {
        lastError = new Error('The Free Router answered with a safety verdict instead of a reply.');
      } else if (text.trim() || reasoning.trim()) {
        if (!onBackup && reply.costCents <= 0) noteAnswered(appId);
        return { text, reasoning, model: appId, usage: spent };
      } else {
        lastError = new Error(`${appId} returned an empty reply`);
      }
    } catch (e) {
      lastError = e;
      if (opts.signal?.aborted) throw e;
      if (e instanceof PuterHttpError && !onBackup) noteRefusal(appId, e);
      // A busy model with a second route goes straight to it on the next try.
      if (e instanceof PuterHttpError && e.kind === 'busy' && backup && !onBackup) {
        i -= 1;
        continue;
      }
      if (!isTransientPuterError(e)) throw e;
    }
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
const ALLOWANCE_CACHE_MS = 60_000;

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
 * or say why. Always the chosen model: a busy Gemma is asked again over
 * Google's route (tools as text there), and the Free Router is asked again
 * when it hands the request to the safety classifier. The call waits its turn
 * in the Que engine's queue and holds it until the stream ends.
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
        if (response.status === 429) { cooldownAppUid(appUid); spawnAppIds(20); }
        throw new PuterHttpError(response.status, await response.text().catch(() => ''));
      }
      if (!(response.headers.get('content-type') ?? '').includes('ndjson')) {
        const body = await response.text();
        const parsed = (() => { try { return JSON.parse(body) as { success?: boolean; error?: unknown }; } catch { return null; } })();
        if (parsed?.success === false || parsed?.error) throw new PuterHttpError(400, body);
        throw new PuterHttpError(502, body);
      }
      return response.body.getReader();
    } finally {
      deadline.clear();
    }
  };
  const openBackup = () => {
    const route = backup!;
    const sent = tools && route.toolsAsText ? textToolMessages(messages, tools) : toolHistoryAsText(messages);
    return open(route.model, sent, tools && !route.toolsAsText ? tools : undefined);
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onBackup = false;
  if (backup && isBusy(appId)) {
    try {
      reader = await openBackup();
      onBackup = true;
    } catch {
      // The main route is tried below.
    }
  }
  if (!reader) {
    try {
      reader = await open(primary, messages, tools);
    } catch (error) {
      if (error instanceof PuterHttpError) noteRefusal(appId, error);
      if (!(error instanceof PuterHttpError) || error.kind !== 'busy' || !backup || opts.signal?.aborted) throw error;
      try {
        reader = await openBackup();
        onBackup = true;
      } catch {
        throw error;
      }
    }
  }

  if (onBackup) {
    // Google's route: the whole reply, then its inline thinking and any tool calls written as text.
    let text = '';
    let reasoning = '';
    let done: Extract<PuterStreamEvent, { type: 'done' }> | null = null;
    for await (const event of readStream(reader, appId, false, keepTurn)) {
      if (event.type === 'text') text += event.text;
      else if (event.type === 'reasoning') reasoning += event.text;
      else if (event.type === 'done') done = event;
    }
    const split = splitThoughtTags(text);
    const parsed = tools && backup!.toolsAsText ? parseTextToolCalls(split.answer, tools.map((tool) => tool.function.name)) : { text: split.answer, calls: [] };
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
  }

  if (appId !== FREE_ROUTER_ID) {
    yield* readStream(reader, appId, true, keepTurn);
    return;
  }
  // The Free Router: hold the first words back until it is clear a chat model answered.
  for (let attempt = 1; ; attempt += 1) {
    const held: PuterStreamEvent[] = [];
    let head = '';
    let decided = false;
    let verdict = false;
    for await (const event of readStream(reader, appId, true, keepTurn)) {
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
    reader = await open(primary, messages, tools);
  }
}

/** The events in one stream; notes what the call said about the model's health. `onPiece` runs as each piece arrives. */
async function* readStream(reader: ReadableStreamDefaultReader<Uint8Array>, appId: string, healthy: boolean, onPiece: () => void): AsyncGenerator<PuterStreamEvent> {
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
      else if (healthy) noteAnswered(appId);
      return {
        type: 'done',
        usage: { inputTokens: Number(usage?.inputTokens ?? raw?.prompt ?? 0) || 0, outputTokens: Number(usage?.outputTokens ?? raw?.completion ?? 0) || 0 },
        stopReason: typeof event.stopReason === 'string' ? event.stopReason : 'end_turn',
      };
    }
    if (event.success === false || event.error) throw new PuterHttpError(502, JSON.stringify(event.error ?? event));
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
