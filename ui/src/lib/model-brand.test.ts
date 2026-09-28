import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_PROVIDERS, modelBrand, modelDisplayName, modelProvider, providerBrand, vendorDisplayName } from "./model-brand";

describe("modelDisplayName", () => {
  it("turns raw model ids into clean names", () => {
    expect(modelDisplayName("claude-sonnet-4-5-20250929")).toBe("Claude Sonnet 4.5");
    expect(modelDisplayName("claude-opus-4-1")).toBe("Claude Opus 4.1");
    expect(modelDisplayName("gpt-5-codex")).toBe("GPT-5 Codex");
    expect(modelDisplayName("gpt-5-mini")).toBe("GPT-5 mini");
    expect(modelDisplayName("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(modelDisplayName("x-ai/grok-4")).toBe("Grok 4");
    expect(modelDisplayName("moonshotai/kimi-k2")).toBe("Kimi K2");
    expect(modelDisplayName("openrouter/deepseek/deepseek-chat")).toBe("DeepSeek Chat");
    expect(modelDisplayName("openrouter/z-ai/glm-4.6")).toBe("GLM 4.6");
    expect(modelDisplayName("")).toBe("Default model");
  });

  it("keeps an adapter label that is already readable, without the catalog's vendor prefix", () => {
    expect(modelDisplayName("claude-sonnet-4-5", "Claude Sonnet 4.5 (1M)")).toBe("Claude Sonnet 4.5 (1M)");
    expect(modelDisplayName("gpt-5", "gpt-5")).toBe("GPT-5");
    expect(modelDisplayName("openrouter/deepseek/deepseek-v4-pro", "DeepSeek: DeepSeek V4 Pro 0423")).toBe("DeepSeek V4 Pro 0423");
    expect(modelDisplayName("openrouter/meta-llama/llama-4-maverick", "Meta: Llama 4 Maverick")).toBe("Llama 4 Maverick");
  });
});

describe("modelProvider", () => {
  it("finds the maker from the id or the agent's adapter", () => {
    expect(modelProvider("claude-haiku-4-5")).toBe("anthropic");
    expect(modelProvider("o3")).toBe("openai");
    expect(modelProvider("anthropic/claude-sonnet-4.5")).toBe("anthropic");
    expect(modelProvider("google/gemini-2.5-flash")).toBe("google");
    expect(modelProvider("", "codex_local")).toBe("openai");
    expect(modelProvider("mystery")).toBe("other");
    expect(modelBrand("grok-4").logo).toBe("/brands/apps/xai.svg");
  });

  it("reads the real maker through OpenRouter and OpenCode ids", () => {
    expect(modelProvider("openrouter/deepseek/deepseek-v4-pro")).toBe("deepseek");
    expect(modelProvider("deepseek/deepseek-reasoner")).toBe("deepseek");
    expect(modelProvider("deepseek-chat")).toBe("deepseek");
    expect(modelProvider("openrouter/mistralai/devstral-medium")).toBe("mistral");
    expect(modelProvider("openrouter/meta-llama/llama-4-maverick")).toBe("meta");
    expect(modelProvider("openrouter/qwen/qwen3-coder")).toBe("qwen");
    expect(modelProvider("openrouter/z-ai/glm-4.6")).toBe("zai");
    expect(modelProvider("openrouter/~anthropic/claude-sonnet-latest")).toBe("anthropic");
    expect(modelProvider("openrouter/openrouter/auto")).toBe("openrouter");
    expect(modelProvider("openrouter/aion-labs/aion-2.0")).toBe("other");
    expect(vendorDisplayName("openrouter/aion-labs/aion-2.0")).toBe("Aion Labs");
    expect(modelBrand("openrouter/deepseek/deepseek-v4-pro")).toMatchObject({ providerName: "DeepSeek", logo: "/brands/models/deepseek.svg" });
  });
});

describe("model logos", () => {
  it("ships every logo file a provider points at", () => {
    const publicDir = path.resolve(__dirname, "../../public");
    for (const provider of MODEL_PROVIDERS) {
      const { logo, darkLogo } = providerBrand(provider);
      for (const asset of [logo, darkLogo]) {
        if (asset) expect(fs.existsSync(path.join(publicDir, asset)), asset).toBe(true);
      }
    }
  });
});
