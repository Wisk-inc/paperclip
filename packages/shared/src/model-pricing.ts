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

/** The bare model id: no region prefix (Bedrock) or long-context suffix. */
function bareModelId(model: string) {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, "");
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
