/**
 * Free models via Puter (chat + image). Server-only: import from
 * "@paperclipai/shared/puter-ai" so the embedded token never ships in the web bundle.
 */

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
} as const;

export type PuterModelKey = keyof typeof PUTER_MODELS;
export type PuterModelId = (typeof PUTER_MODELS)[PuterModelKey];
export const PUTER_MODEL_LIST: PuterModelId[] = Object.values(PUTER_MODELS);

export const PUTER_MODEL_META: Record<PuterModelKey, { label: string; context: number; tags: string[] }> = {
  'nemotron-ultra':          { label: 'Nemotron 3 Ultra 550B', context: 1_000_000, tags: ['heavy', 'smart'] },
  'nemotron-super':          { label: 'Nemotron 3 Super 120B', context: 262_000, tags: ['heavy'] },
  'nemotron-nano-reasoning': { label: 'Nemotron 3 Nano Omni 30B Reasoning', context: 256_000, tags: ['reasoning'] },
  'nemotron-lightning':      { label: 'Nemotron 3.5 Lightning', context: 1_000_000, tags: ['fast'] },
  'nemotron-vision':         { label: 'Nemotron 3.5 Super VL', context: 1_000_000, tags: ['vision'] },
  'nemotron-safety':         { label: 'Nemotron 3.5 Content Safety', context: 128_000, tags: ['safety'] },
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
};

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
// One stable app id per process: rotating ids to multiply Puter's rate limit risks the token being banned.
const APP_UID = 'automa-' + crypto.randomUUID();

function resolveModel(input?: string): string {
  if (!input) return PUTER_MODELS['deepseek-flash'];
  if (input in PUTER_MODELS) return PUTER_MODELS[input as PuterModelKey];
  return input;
}

function resolveImageModel(input?: string): PuterImageModelId {
  if (!input) return PUTER_IMAGE_MODELS['sdxl-lightning'];
  if (input in PUTER_IMAGE_MODELS) return PUTER_IMAGE_MODELS[input as PuterImageModelKey];
  if (isPuterImageModel(input)) return input;
  throw new Error(`Unknown image model: ${input}`);
}

function resolveToken(explicit?: string): string {
  const fromEnv = typeof process !== 'undefined' ? process.env?.PUTER_AUTH_TOKEN : undefined;
  return explicit || fromEnv || EMBEDDED_TOKEN;
}

export class PuterHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Free model service answered ${status}: ${body.slice(0, 300)}`);
  }
}

async function driverCall(body: Record<string, unknown>, token: string, signal?: AbortSignal): Promise<unknown> {
  const r = await fetch(PUTER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;actually=json' },
    body: JSON.stringify({ ...body, auth_token: token, app_uid: APP_UID }),
    signal: signal ?? AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new PuterHttpError(r.status, await r.text().catch(() => ''));
  const d = await r.json() as { success?: boolean; result?: unknown; error?: unknown };
  if (d.success === false) throw new PuterHttpError(502, JSON.stringify(d.error ?? d));
  return d.result;
}

async function callChat(
  messages: PuterMessage[],
  model: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ text: string; reasoning: string; usage: PuterUsage }> {
  const result = await driverCall(
    { interface: 'puter-chat-completion', driver: 'ai-chat', method: 'complete', args: { messages, model } },
    token,
    signal,
  ) as {
    message?: { content?: unknown; reasoning?: unknown };
    usage?: { prompt?: number; completion?: number };
    usageDetails?: { inputTokens?: number; outputTokens?: number };
  } | undefined;
  const usage = {
    inputTokens: Number(result?.usageDetails?.inputTokens ?? result?.usage?.prompt ?? 0) || 0,
    outputTokens: Number(result?.usageDetails?.outputTokens ?? result?.usage?.completion ?? 0) || 0,
  };
  const reasoning = typeof result?.message?.reasoning === 'string' ? result.message.reasoning : '';
  const content = result?.message?.content;
  if (typeof content === 'string') return { text: content, reasoning, usage };
  if (Array.isArray(content)) {
    const text = content.map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? '')).join('');
    return { text, reasoning, usage };
  }
  return { text: '', reasoning, usage };
}

/** Chat with retry: waits on 429, moves to the next free model when one is unavailable. */
export async function puterComplete(
  messages: PuterMessage[],
  opts: PuterChatOptions = {},
): Promise<{ text: string; reasoning: string; model: string; usage: PuterUsage }> {
  const token = resolveToken(opts.token);
  const requested = resolveModel(opts.model);
  const retries = opts.retries ?? 5;
  let idx = PUTER_MODEL_LIST.indexOf(requested as PuterModelId);
  let lastError: unknown;
  const spent: PuterUsage = { inputTokens: 0, outputTokens: 0 };
  for (let i = 0; i < retries; i++) {
    const model = i === 0 || idx < 0 ? requested : PUTER_MODEL_LIST[idx % PUTER_MODEL_LIST.length]!;
    try {
      const { text, reasoning, usage } = await callChat(messages, model, token, opts.signal);
      spent.inputTokens += usage.inputTokens;
      spent.outputTokens += usage.outputTokens;
      if (text.trim()) return { text, reasoning, model, usage: spent };
      lastError = new Error(`${model} returned an empty reply`);
      if (idx < 0) idx = 0; else idx++;
    } catch (e) {
      lastError = e;
      if (opts.signal?.aborted) throw e;
      const status = e instanceof PuterHttpError ? e.status : 0;
      if (status === 429) { await new Promise((r) => setTimeout(r, 2000 * (i + 1))); continue; }
      if (status === 400 || status === 402 || status === 404 || status === 502 || status === 503) {
        if (idx < 0) idx = 0; else idx++;
        continue;
      }
      throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The free models are busy. Try again in a minute.');
}

/** One-shot chat. */
export async function puterChat(prompt: string | PuterMessage[], opts: PuterChatOptions = {}): Promise<string> {
  const messages = typeof prompt === 'string' ? [{ role: 'user' as const, content: prompt }] : prompt;
  return (await puterComplete(messages, opts)).text;
}

const convos: Record<string, { messages: PuterMessage[]; model: string }> = {};

/** Multi-turn conversation kept in process memory. */
export async function puterConvo(prompt: string, id = 'default', opts: PuterConvoOptions = {}): Promise<string> {
  if (!convos[id]) convos[id] = { messages: [], model: resolveModel(opts.model) };
  const c = convos[id];
  if (opts.system && !c.messages.some((m) => m.role === 'system')) {
    c.messages.unshift({ role: 'system', content: opts.system });
  }
  c.messages.push({ role: 'user', content: prompt });
  const { text } = await puterComplete(c.messages, { ...opts, model: c.model });
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

/** First chat model carrying `tag` (e.g. "code", "fast", "vision"), else DeepSeek Flash. */
export function puterPickModel(tag: string): PuterModelId {
  for (const [key, meta] of Object.entries(PUTER_MODEL_META)) {
    if (meta.tags.includes(tag)) return PUTER_MODELS[key as PuterModelKey];
  }
  return PUTER_MODELS['deepseek-flash'];
}

/** Text-to-image. Resolves to the image bytes and its MIME type. */
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
 * (with its status) when the call is refused, so callers can retry or fall back.
 */
export async function* puterStream(messages: PuterMessage[], opts: PuterStreamOptions = {}): AsyncGenerator<PuterStreamEvent> {
  const response = await fetch(PUTER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;actually=json' },
    body: JSON.stringify({
      interface: 'puter-chat-completion',
      driver: 'ai-chat',
      method: 'complete',
      args: { messages, model: resolveModel(opts.model), stream: true, ...(opts.tools?.length ? { tools: opts.tools } : {}) },
      auth_token: resolveToken(opts.token),
      app_uid: APP_UID,
    }),
    signal: opts.signal ?? AbortSignal.timeout(300_000),
  });
  if (!response.ok || !response.body) throw new PuterHttpError(response.status, await response.text().catch(() => ''));
  if (!(response.headers.get('content-type') ?? '').includes('ndjson')) {
    // A refusal arrives as one JSON object instead of a stream.
    const body = await response.text();
    const parsed = (() => { try { return JSON.parse(body) as { success?: boolean; error?: unknown }; } catch { return null; } })();
    if (parsed?.success === false || parsed?.error) throw new PuterHttpError(400, body);
    throw new PuterHttpError(502, body);
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
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
      const raw = event.usage as { prompt?: number; completion?: number } | undefined;
      return {
        type: 'done',
        usage: { inputTokens: Number(usage?.inputTokens ?? raw?.prompt ?? 0) || 0, outputTokens: Number(usage?.outputTokens ?? raw?.completion ?? 0) || 0 },
        stopReason: typeof event.stopReason === 'string' ? event.stopReason : 'end_turn',
      };
    }
    if (event.success === false || event.error) throw new PuterHttpError(502, JSON.stringify(event.error ?? event));
    return null;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
