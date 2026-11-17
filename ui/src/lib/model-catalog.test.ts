import { describe, expect, it } from "vitest";
import type { CatalogModel } from "@paperclipai/shared/model-catalog";
import { studioModelsWithCatalog, terminalModelsWithCatalog } from "./model-catalog";

const now = Math.floor(Date.now() / 1000);
function model(id: string, daysAgo: number): CatalogModel {
  return { id, name: id, created: now - daysAgo * 86_400, context: null, tools: true, input: ["text"], output: ["text"], price: null };
}

const CATALOG = [
  model("qwen/qwen4-max", 1),
  model("google/gemini-4-hydrogen", 5),
  model("anthropic/claude-fable-5.2", 8),
  model("deepseek/deepseek-v4.2", 9),
  model("google/gemini-4-argon", 35),
];

describe("model lists with the catalog's newer models", () => {
  it("puts App Studio's new models first, in each provider's own ids, and says which are new", () => {
    const anthropic = studioModelsWithCatalog("anthropic", ["claude-opus-5-5", "claude-fable-5-1"], CATALOG);
    expect(anthropic.models).toEqual(["claude-fable-5-2", "claude-opus-5-5", "claude-fable-5-1"]);
    expect([...anthropic.added]).toEqual(["claude-fable-5-2"]);
    expect(studioModelsWithCatalog("google", ["gemini-4-argon"], CATALOG).models).toEqual(["gemini-4-hydrogen", "gemini-4-argon"]);
    expect(studioModelsWithCatalog("openrouter", ["anthropic/claude-opus-5.5"], CATALOG).models.slice(0, 2)).toEqual(["qwen/qwen4-max", "google/gemini-4-hydrogen"]);
  });

  it("leaves providers whose own ids the catalog does not use as they are", () => {
    // DeepSeek's API takes deepseek-chat and deepseek-reasoner, not the catalog's names.
    expect(studioModelsWithCatalog("deepseek", ["deepseek-chat"], CATALOG)).toEqual({ models: ["deepseek-chat"], added: new Set() });
    expect(studioModelsWithCatalog("free", ["nvidia/nemotron-3-ultra-550b-a55b:free"], CATALOG).models).toEqual(["nvidia/nemotron-3-ultra-550b-a55b:free"]);
  });

  it("follows the catalog for Claude Code, Codex and Gemini CLI, not the other terminal tools", () => {
    expect(terminalModelsWithCatalog("gemini", ["gemini-4-argon"], CATALOG).models[0]).toBe("gemini-4-hydrogen");
    expect(terminalModelsWithCatalog("claude", ["claude-opus-5-5"], CATALOG).models[0]).toBe("claude-fable-5-2");
    expect(terminalModelsWithCatalog("kimi", ["kimi-code/k3"], CATALOG).models).toEqual(["kimi-code/k3"]);
  });

  it("is the list as it was before the catalog arrives", () => {
    expect(studioModelsWithCatalog("google", ["gemini-4-argon"], undefined)).toEqual({ models: ["gemini-4-argon"], added: new Set() });
  });
});
