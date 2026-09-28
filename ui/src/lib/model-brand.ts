/**
 * Clean provider logos and names for AI models, so model pickers and badges
 * read "Claude Sonnet 4.5" with the Anthropic mark instead of a raw id such
 * as "claude-sonnet-4-5-20250929", and "DeepSeek V4 Pro" with the DeepSeek
 * mark instead of "openrouter/deepseek/deepseek-v4-pro".
 */
export const MODEL_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "mistral",
  "meta",
  "qwen",
  "moonshot",
  "zai",
  "minimax",
  "nvidia",
  "cohere",
  "perplexity",
  "amazon",
  "microsoft",
  "bytedance",
  "tencent",
  "baidu",
  "stepfun",
  "ibm",
  "inception",
  "liquid",
  "nousresearch",
  "arcee",
  "openrouter",
  "other",
] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelBrand {
  provider: ModelProvider;
  providerName: string;
  /** Logo for light surfaces. */
  logo: string | null;
  /** Logo for dark surfaces, when the brand ships one. */
  darkLogo: string | null;
}

function brand(provider: ModelProvider, providerName: string, logo: string | null, darkLogo: string | null = null): ModelBrand {
  return { provider, providerName, logo, darkLogo };
}

const MODELS = "/brands/models";
const BRANDS: Record<ModelProvider, ModelBrand> = {
  anthropic: brand("anthropic", "Anthropic", "/brands/apps/anthropic.svg", "/brands/apps/anthropic-dark.svg"),
  openai: brand("openai", "OpenAI", "/brands/apps/openai.svg", "/brands/apps/openai-dark.svg"),
  google: brand("google", "Google", "/brands/adapters/gemini-color.svg"),
  xai: brand("xai", "xAI", "/brands/apps/xai.svg", "/brands/apps/xai-dark.svg"),
  deepseek: brand("deepseek", "DeepSeek", `${MODELS}/deepseek.svg`),
  mistral: brand("mistral", "Mistral AI", `${MODELS}/mistral.svg`),
  meta: brand("meta", "Meta", `${MODELS}/meta.svg`),
  qwen: brand("qwen", "Qwen", `${MODELS}/qwen.svg`),
  moonshot: brand("moonshot", "Moonshot AI", "/brands/adapters/kimi-color.svg"),
  zai: brand("zai", "Z.ai", `${MODELS}/zai.svg`, `${MODELS}/zai-dark.svg`),
  minimax: brand("minimax", "MiniMax", `${MODELS}/minimax.svg`),
  nvidia: brand("nvidia", "NVIDIA", `${MODELS}/nvidia.svg`),
  cohere: brand("cohere", "Cohere", `${MODELS}/cohere.svg`),
  perplexity: brand("perplexity", "Perplexity", `${MODELS}/perplexity.svg`),
  amazon: brand("amazon", "Amazon", `${MODELS}/nova.svg`),
  microsoft: brand("microsoft", "Microsoft", `${MODELS}/microsoft.svg`),
  bytedance: brand("bytedance", "ByteDance", `${MODELS}/bytedance.svg`),
  tencent: brand("tencent", "Tencent", `${MODELS}/hunyuan.svg`),
  baidu: brand("baidu", "Baidu", `${MODELS}/baidu.svg`),
  stepfun: brand("stepfun", "StepFun", `${MODELS}/stepfun.svg`),
  ibm: brand("ibm", "IBM", `${MODELS}/ibm.svg`, `${MODELS}/ibm-dark.svg`),
  inception: brand("inception", "Inception", `${MODELS}/inception.svg`, `${MODELS}/inception-dark.svg`),
  liquid: brand("liquid", "Liquid AI", `${MODELS}/liquid.svg`, `${MODELS}/liquid-dark.svg`),
  nousresearch: brand("nousresearch", "Nous Research", `${MODELS}/nousresearch.svg`, `${MODELS}/nousresearch-dark.svg`),
  arcee: brand("arcee", "Arcee AI", `${MODELS}/arcee.svg`),
  openrouter: brand("openrouter", "OpenRouter", "/brands/apps/openrouter.svg", "/brands/apps/openrouter-dark.svg"),
  other: brand("other", "Other", null),
};

/** Vendor segments used in `vendor/model` ids (OpenRouter, OpenCode). */
const VENDORS: Record<string, ModelProvider> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "google-vertex": "google",
  xai: "xai",
  "x-ai": "xai",
  deepseek: "deepseek",
  mistral: "mistral",
  mistralai: "mistral",
  meta: "meta",
  "meta-llama": "meta",
  qwen: "qwen",
  alibaba: "qwen",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  "z-ai": "zai",
  zai: "zai",
  zhipuai: "zai",
  minimax: "minimax",
  nvidia: "nvidia",
  cohere: "cohere",
  perplexity: "perplexity",
  amazon: "amazon",
  "amazon-bedrock": "amazon",
  microsoft: "microsoft",
  bytedance: "bytedance",
  "bytedance-seed": "bytedance",
  tencent: "tencent",
  baidu: "baidu",
  stepfun: "stepfun",
  "stepfun-ai": "stepfun",
  "ibm-granite": "ibm",
  ibm: "ibm",
  inception: "inception",
  liquid: "liquid",
  nousresearch: "nousresearch",
  "arcee-ai": "arcee",
  openrouter: "openrouter",
};

/** Model-family prefixes for bare ids such as "claude-sonnet-4-5" or "deepseek-chat". */
const FAMILIES: Array<[RegExp, ModelProvider]> = [
  [/^claude/, "anthropic"],
  [/^(gpt|o\d|codex|chatgpt)/, "openai"],
  [/^(gemini|gemma)/, "google"],
  [/^grok/, "xai"],
  [/^deepseek/, "deepseek"],
  [/^(mistral|mixtral|codestral|devstral|magistral|ministral|pixtral|voxtral)/, "mistral"],
  [/^llama/, "meta"],
  [/^(qwen|qwq)/, "qwen"],
  [/^(kimi|moonshot)/, "moonshot"],
  [/^glm/, "zai"],
  [/^minimax/, "minimax"],
  [/^nemotron/, "nvidia"],
  [/^(command|aya)/, "cohere"],
  [/^(sonar|r1-1776)/, "perplexity"],
  [/^nova/, "amazon"],
  [/^phi/, "microsoft"],
  [/^(seed|doubao)/, "bytedance"],
  [/^hunyuan/, "tencent"],
  [/^ernie/, "baidu"],
  [/^step/, "stepfun"],
  [/^granite/, "ibm"],
  [/^mercury/, "inception"],
  [/^(lfm|liquid)/, "liquid"],
  [/^hermes/, "nousresearch"],
];

const ADAPTER_PROVIDERS: Record<string, ModelProvider> = {
  claude_local: "anthropic",
  codex_local: "openai",
  gemini_local: "google",
  grok_local: "xai",
  kimi_local: "moonshot",
  opencode_local: "openrouter",
};

/** Splits "openrouter/deepseek/deepseek-v4-pro" into its vendor and model parts. */
function idParts(modelId: string): { vendor: string; bare: string } {
  const segments = modelId.toLowerCase().split("/").filter(Boolean).map((segment) => segment.replace(/^~/, ""));
  if (segments.length > 2 && segments[0] === "openrouter") segments.shift();
  if (segments.length < 2) return { vendor: "", bare: segments[0] ?? "" };
  return { vendor: segments[0]!, bare: segments.slice(1).join("/") };
}

/** Which company made a model, from its id (falling back to the agent's adapter). */
export function modelProvider(modelId: string | null | undefined, adapterType?: string | null): ModelProvider {
  const { vendor, bare } = idParts((modelId ?? "").trim());
  const family = FAMILIES.find(([pattern]) => pattern.test(bare))?.[1];
  const byVendor = vendor ? VENDORS[vendor] : undefined;
  if (byVendor && byVendor !== "openrouter") return byVendor;
  if (family) return family;
  if (byVendor) return byVendor;
  if (vendor) return "other";
  return (adapterType && ADAPTER_PROVIDERS[adapterType]) || "other";
}

export function modelBrand(modelId: string | null | undefined, adapterType?: string | null): ModelBrand {
  return BRANDS[modelProvider(modelId, adapterType)];
}

export function providerBrand(provider: ModelProvider): ModelBrand {
  return BRANDS[provider];
}

/** A vendor's display name when it has no brand of its own ("aion-labs" → "Aion Labs"). */
export function vendorDisplayName(modelId: string | null | undefined): string {
  const { vendor } = idParts((modelId ?? "").trim());
  if (!vendor) return BRANDS.other.providerName;
  return vendor.split(/[-_]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

const WORD_OVERRIDES: Record<string, string> = {
  gpt: "GPT",
  glm: "GLM",
  claude: "Claude",
  gemini: "Gemini",
  gemma: "Gemma",
  grok: "Grok",
  kimi: "Kimi",
  codex: "Codex",
  deepseek: "DeepSeek",
  llama: "Llama",
  qwen: "Qwen",
  minimax: "MiniMax",
  mini: "mini",
  nano: "nano",
  pro: "Pro",
  max: "Max",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  flash: "Flash",
  lite: "Lite",
  turbo: "Turbo",
  latest: "(latest)",
};

/**
 * A readable model name. Keeps an adapter-supplied label when it is already
 * human ("Claude Sonnet 4.5"), dropping a catalog's "Vendor: " prefix
 * ("DeepSeek: DeepSeek V4 Pro" → "DeepSeek V4 Pro"); otherwise tidies the id:
 * drops the vendor prefix and date stamps and joins version digits
 * ("4-5" → "4.5").
 */
export function modelDisplayName(modelId: string | null | undefined, label?: string | null): string {
  const cleanLabel = label?.trim();
  if (cleanLabel && cleanLabel !== modelId && /[A-Z ]/.test(cleanLabel)) {
    const withoutVendor = cleanLabel.replace(/^[^:()]{1,40}:\s+/, "");
    return withoutVendor || cleanLabel;
  }
  const id = (modelId ?? "").trim();
  if (!id) return "Default model";
  let bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  bare = bare.replace(/^~/, "").replace(/:[a-z]+$/i, "");
  bare = bare.replace(/[-_@]20\d{6}$/, "").replace(/[-_]\d{4}-\d{2}-\d{2}$/, "");
  const parts = bare.split(/[-_\s]+/).filter(Boolean);
  const words: string[] = [];
  for (const part of parts) {
    const previous = words[words.length - 1];
    // "4" followed by "5" is a version: "4.5".
    if (previous && /^\d+(\.\d+)?$/.test(previous) && /^\d{1,2}$/.test(part)) {
      words[words.length - 1] = `${previous}.${part}`;
      continue;
    }
    const lower = part.toLowerCase();
    words.push(WORD_OVERRIDES[lower] ?? (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)));
  }
  // "GPT 5" reads as "GPT-5", the vendor's own spelling.
  if (words[0] === "GPT" && words[1] && /^\d/.test(words[1])) {
    words.splice(0, 2, `GPT-${words[1]}`);
  }
  return words.join(" ");
}
