/**
 * Free AI models via the Puter public API.
 *
 * Set PUTER_AUTH_TOKEN in environment to authenticate.
 * All models are $0/forever — no billing required.
 */

// ── Model catalog ──────────────────────────────────────────────

export const PUTER_MODELS = {
  // Heavy / smart
  'nemotron-ultra':          'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nemotron-super':          'nvidia/nemotron-3-super-120b-a12b:free',
  'nemotron-lightning':      'nvidia/nemotron-3.5-lightning:free',

  // Reasoning / vision / safety
  'nemotron-nano-reasoning': 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nemotron-vision':         'nvidia/nemotron-3.5-super-vl:free',
  'nemotron-safety':         'nvidia/nemotron-3.5-content-safety:free',

  // DeepSeek
  'deepseek-flash':          'deepseek/deepseek-v4.1-flash:free',

  // Google
  'gemma-31b':               'google/gemma-4-31b-it:free',
  'gemma-26b':               'google/gemma-4-26b-a4b-it:free',

  // Qwen
  'qwen-27b':                'qwen/qwen3.8-27b:free',
  'qwen-abliterated':        'qwen/qwen3.8-27b-abliterated-cyber:free',

  // ThinkingMachines
  'inkling':                 'thinkingmachines/inkling:free',
  'inkling-small':           'thinkingmachines/inkling-small:free',

  // Code
  'north-mini-code':         'cohere/north-mini-code:free',

  // Others
  'flint':                   'recursive/flint-v1.0:free',
  'atria-dawn':              'internlm/atria-dawn-preview:free',
  'apodex-mini':             'apodex/apodex-1.1-mini:free',
  'lfm-tiny':                'liquid/lfm-2.5-2.6b:free',
  'xing4':                   'xingchen-agi/xing4.0-29b-a4b:free',
} as const;

export type PuterModelKey = keyof typeof PUTER_MODELS;
export type PuterModelId  = (typeof PUTER_MODELS)[PuterModelKey];

export const PUTER_MODEL_LIST: PuterModelId[] = Object.values(PUTER_MODELS);

export const PUTER_MODEL_META: Record<PuterModelKey, { context: number; tags: string[] }> = {
  'nemotron-ultra':          { context: 1_000_000, tags: ['heavy', 'smart'] },
  'nemotron-super':          { context: 262_000,   tags: ['heavy'] },
  'nemotron-lightning':      { context: 1_000_000, tags: ['fast'] },
  'nemotron-nano-reasoning': { context: 256_000,   tags: ['reasoning'] },
  'nemotron-vision':         { context: 1_000_000, tags: ['vision', 'multimodal'] },
  'nemotron-safety':         { context: 128_000,   tags: ['safety', 'moderation'] },
  'deepseek-flash':          { context: 1_000_000, tags: ['fast', 'smart'] },
  'gemma-31b':               { context: 262_000,   tags: ['google'] },
  'gemma-26b':               { context: 262_000,   tags: ['google', 'small'] },
  'qwen-27b':                { context: 256_000,   tags: ['alibaba'] },
  'qwen-abliterated':        { context: 256_000,   tags: ['uncensored'] },
  'inkling':                 { context: 1_000_000, tags: ['large-context'] },
  'inkling-small':           { context: 1_000_000, tags: ['large-context', 'small'] },
  'north-mini-code':         { context: 256_000,   tags: ['code'] },
  'flint':                   { context: 262_000,   tags: [] },
  'atria-dawn':              { context: 256_000,   tags: [] },
  'apodex-mini':             { context: 262_000,   tags: [] },
  'lfm-tiny':                { context: 65_000,    tags: ['tiny', 'fast'] },
  'xing4':                   { context: 262_000,   tags: [] },
};

// ── Types ──────────────────────────────────────────────────────

export interface PuterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PuterChatOptions {
  model?: PuterModelId | PuterModelKey;
  retries?: number;
  token?: string;
}

export interface PuterConvoOptions extends PuterChatOptions {
  system?: string;
}

// ── Helpers ─────────────────────────────────────────────────────

function resolveModel(input?: PuterModelId | PuterModelKey): PuterModelId {
  if (!input) return PUTER_MODELS['nemotron-ultra'];
  if (input in PUTER_MODELS) return PUTER_MODELS[input as PuterModelKey];
  return input as PuterModelId;
}

function resolveToken(explicit?: string): string {
  const t = explicit || process.env.PUTER_AUTH_TOKEN;
  if (!t) throw new Error('PUTER_AUTH_TOKEN not set — provide it in env or pass token option');
  return t;
}

// App ID rotation for rate-limit distribution
const appIds: string[] = [];
let appIdx = 0;
function nextAppId(): string {
  if (appIds.length === 0) {
    for (let i = 0; i < 50; i++) appIds.push('px-' + crypto.randomUUID());
  }
  return appIds[appIdx++ % appIds.length];
}

// ── Core fetch ──────────────────────────────────────────────────

const PUTER_API = 'https://api.puter.com/drivers/call';

async function callPuter(messages: PuterMessage[], model: PuterModelId, token: string): Promise<string> {
  const r = await fetch(PUTER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;actually=json' },
    body: JSON.stringify({
      interface: 'puter-chat-completion',
      driver: 'ai-chat',
      method: 'complete',
      args: { messages, model },
      auth_token: token,
      app_uid: nextAppId(),
    }),
  });
  if (!r.ok) throw new Error(`Puter ${r.status}: ${await r.text().catch(() => '')}`);
  const d = await r.json() as { result?: { message?: { content?: string } } };
  return d?.result?.message?.content || '';
}

// ── Smart call with retry + model fallback ──────────────────────

async function smartCall(messages: PuterMessage[], model: PuterModelId, token: string, retries: number): Promise<string> {
  let idx = PUTER_MODEL_LIST.indexOf(model);
  if (idx < 0) idx = 0;

  for (let i = 0; i < retries; i++) {
    const m = PUTER_MODEL_LIST[idx % PUTER_MODEL_LIST.length];
    try {
      return await callPuter(messages, m, token);
    } catch (e) {
      const s = e instanceof Error ? e.message : String(e);
      if (s.includes('429')) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
      if (s.includes('402') || s.includes('400') || s.includes('404')) { idx++; continue; }
      throw e;
    }
  }
  throw new Error('All Puter retries exhausted');
}

// ══════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════

/** One-shot chat: returns the assistant reply. */
export async function puterChat(prompt: string | PuterMessage[], opts: PuterChatOptions = {}): Promise<string> {
  const messages = typeof prompt === 'string' ? [{ role: 'user' as const, content: prompt }] : prompt;
  const model = resolveModel(opts.model);
  const token = resolveToken(opts.token);
  return smartCall(messages, model, token, opts.retries ?? 5);
}

// ── Conversation memory ─────────────────────────────────────────

const convos: Record<string, { messages: PuterMessage[]; model: PuterModelId; token: string }> = {};

/** Multi-turn conversation with memory (in-process). */
export async function puterConvo(prompt: string, id = 'default', opts: PuterConvoOptions = {}): Promise<string> {
  const token = resolveToken(opts.token);
  if (!convos[id]) convos[id] = { messages: [], model: resolveModel(opts.model), token };
  const c = convos[id];
  if (opts.system && !c.messages.find(m => m.role === 'system')) {
    c.messages.unshift({ role: 'system', content: opts.system });
  }
  c.messages.push({ role: 'user', content: prompt });
  const reply = await smartCall(c.messages, c.model, c.token, opts.retries ?? 5);
  c.messages.push({ role: 'assistant', content: reply });
  return reply;
}

/** Fire multiple prompts in parallel. Nulls for failures. */
export async function puterBatch(prompts: string[], opts: PuterChatOptions = {}): Promise<(string | null)[]> {
  const results = await Promise.allSettled(prompts.map(p => puterChat(p, opts)));
  return results.map(r => r.status === 'fulfilled' ? r.value : null);
}

/** Clear a conversation's history. */
export function puterClearConvo(id = 'default'): void { delete convos[id]; }

/** Pick the best model for a use case by tag. */
export function puterPickModel(tag: string): PuterModelId {
  for (const [key, meta] of Object.entries(PUTER_MODEL_META)) {
    if (meta.tags.includes(tag)) return PUTER_MODELS[key as PuterModelKey];
  }
  return PUTER_MODELS['nemotron-ultra'];
}
