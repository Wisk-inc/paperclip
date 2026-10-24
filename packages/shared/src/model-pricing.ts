/**
 * List prices for Claude models, in US dollars per million tokens, so a call
 * made with a person's own API key can be counted in Costs even when the
 * provider reports only tokens. Prompt-cache writes are priced at 1.25x the
 * input price (5-minute cache) and reads at the model's cache-read price.
 */
export interface ClaudeModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Haiku 5.5 charges more once a prompt passes this many input tokens. */
  longPromptThreshold?: number;
  longPrompt?: { input: number; output: number; cacheRead: number };
}

const PRICES: Array<[RegExp, ClaudeModelPrice]> = [
  [/^claude-(?:fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/^claude-(?:fable|mythos)-5/, { input: 10, output: 50, cacheRead: 1 }],
  [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/^claude-opus-5/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/^claude-opus-4-[5-9]/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/^claude-opus-4/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/^claude-sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/^claude-sonnet-4/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/^claude-3-7-sonnet|^claude-3-5-sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [
    /^claude-haiku-5-5/,
    {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      longPromptThreshold: 100_000,
      longPrompt: { input: 0.5, output: 2.5, cacheRead: 0.05 },
    },
  ],
  [/^claude-haiku-4-5/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/^claude-3-5-haiku/, { input: 0.8, output: 4, cacheRead: 0.08 }],
];

/** Short names Claude Code accepts for the newest model of each family. */
const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-1",
};

/**
 * The bare model id: no provider or region prefix (Bedrock's
 * "us-gov.anthropic.", OpenRouter's "anthropic/"), no long-context suffix,
 * and versions written with dashes ("claude-opus-4.5" is claude-opus-4-5).
 */
function bareModelId(model: string) {
  const id = model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/^anthropic\//, "")
    .replace(/^(?:[a-z][a-z-]*\.)?anthropic\./, "")
    .replace(/(\d)\.(\d)/g, "$1-$2");
  return MODEL_ALIASES[id] ?? id;
}

export function claudeModelPrice(model: string): ClaudeModelPrice | null {
  const id = bareModelId(model);
  for (const [pattern, price] of PRICES) if (pattern.test(id)) return price;
  return null;
}

export interface ClaudeUsageForPricing {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * The list-price cost of one response, or null for a model without a known
 * price (a gateway's own model name, for example).
 */
export function estimateClaudeCostUsd(model: string, usage: ClaudeUsageForPricing): number | null {
  const base = claudeModelPrice(model);
  if (!base) return null;
  const cacheRead = Math.max(0, usage.cacheReadInputTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheCreationInputTokens ?? 0);
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  const promptTokens = input + cacheRead + cacheWrite;
  const price =
    base.longPrompt && base.longPromptThreshold && promptTokens > base.longPromptThreshold ? { ...base, ...base.longPrompt } : base;
  const cost =
    (input * price.input + cacheWrite * price.input * 1.25 + cacheRead * price.cacheRead + output * price.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** The token counts of a Messages API `usage` object, as it arrives on the wire. */
export interface ClaudeApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Per-attempt usage when the server retried or fell back (each attempt is billed). */
  iterations?: Array<ClaudeApiUsage & { model?: string | null }> | null;
}

/**
 * What a reply really cost: every attempt in `usage.iterations` when there is
 * one (a declined attempt and a fallback model are billed too, each at its
 * own model's price), otherwise the top-level counts. Input includes cache
 * writes; cached input is the cache reads.
 */
export function claudeBilledSpend(model: string, usage: ClaudeApiUsage) {
  const parts = Array.isArray(usage.iterations) && usage.iterations.length > 0 ? usage.iterations : [{ ...usage, model }];
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;
  for (const part of parts) {
    const input = Math.max(0, part.input_tokens ?? 0);
    const cacheRead = Math.max(0, part.cache_read_input_tokens ?? 0);
    const cacheWrite = Math.max(0, part.cache_creation_input_tokens ?? 0);
    const output = Math.max(0, part.output_tokens ?? 0);
    inputTokens += input + cacheWrite;
    cachedInputTokens += cacheRead;
    outputTokens += output;
    const partCost = estimateClaudeCostUsd(part.model || model, {
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite,
    });
    costUsd = costUsd === null || partCost === null ? null : costUsd + partCost;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: costUsd === null ? null : Math.round(costUsd * 1_000_000) / 1_000_000,
  };
}

/** Per million tokens, in US dollars, for models other than Claude. */
export interface ApiModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Prices for the newer non-Claude models people pick in Automa, from the
 * providers' own pricing pages (October 2026). A model missing here is
 * recorded as unpriced rather than guessed. Gemini 4 Argon's launch price
 * doubles on 1 December 2026, so its rate depends on the date.
 */
const API_MODEL_PRICES: Array<[RegExp, (at: Date) => ApiModelPrice]> = [
  [
    /^(?:google\/)?gemini-4-argon(?::batch)?$/,
    (at) =>
      at.getTime() < Date.UTC(2026, 11, 1)
        ? { input: 2, cachedInput: 0.1, output: 10 }
        : { input: 4, cachedInput: 0.2, output: 20 },
  ],
  // No published cache rate for Highspeed: cached input is counted at the
  // full input rate, so a spending cap errs on the safe side.
  [/^(?:moonshotai\/)?kimi-k3\.1-pro-highspeed$/, () => ({ input: 4, cachedInput: 4, output: 20 })],
  [/^(?:moonshotai\/)?kimi-k3\.1-pro$/, () => ({ input: 2, cachedInput: 0.2, output: 10 })],
  [/^(?:moonshotai\/)?kimi-k3$/, () => ({ input: 3, cachedInput: 0.3, output: 15 })],
];

export function apiModelPrice(model: string, at: Date = new Date()): ApiModelPrice | null {
  const id = model.trim().toLowerCase();
  for (const [pattern, price] of API_MODEL_PRICES) if (pattern.test(id)) return price(at);
  return null;
}

/** Cost of one call to an OpenAI-compatible API, or null when the model has no known price. */
export function estimateApiCostUsd(
  model: string,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  at: Date = new Date(),
): number | null {
  const price = apiModelPrice(model, at);
  if (!price) return null;
  const cost =
    (usage.inputTokens * price.input + usage.cachedInputTokens * price.cachedInput + usage.outputTokens * price.output) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
