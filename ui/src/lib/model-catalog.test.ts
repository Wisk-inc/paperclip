import { describe, expect, it } from "vitest";
import type { CatalogModel } from "@paperclipai/shared/model-catalog";
import { newestCatalogModelIds, studioModelsWithCatalog, terminalModelsWithCatalog } from "./model-catalog";

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
    expect(studioModelsWithCatalog("deepseek", ["deepseek-chat"], CATALOG)).toEqual({ models: ["deepseek-chat"], added: new Set(), fresh: new Set() });
    expect(studioModelsWithCatalog("free", ["nvidia/nemotron-3-ultra-550b-a55b:free"], CATALOG).models).toEqual(["nvidia/nemotron-3-ultra-550b-a55b:free"]);
  });

  it("follows the catalog for Claude Code, Codex and Gemini CLI, not the other terminal tools", () => {
    expect(terminalModelsWithCatalog("gemini", ["gemini-4-argon"], CATALOG).models[0]).toBe("gemini-4-hydrogen");
    expect(terminalModelsWithCatalog("claude", ["claude-opus-5-5"], CATALOG).models[0]).toBe("claude-fable-5-2");
    expect(terminalModelsWithCatalog("kimi", ["kimi-code/k3"], CATALOG).models).toEqual(["kimi-code/k3"]);
  });

  it("is the list as it was before the catalog arrives", () => {
    expect(studioModelsWithCatalog("google", ["gemini-4-argon"], undefined)).toEqual({ models: ["gemini-4-argon"], added: new Set(), fresh: new Set() });
  });

  it("lists older models a list lacks after it, so the newest stay on top", () => {
    const google = studioModelsWithCatalog("google", ["gemini-4-hydrogen"], [model("google/gemini-5-pro", 2), model("google/gemini-4-hydrogen", 5), model("google/gemini-3.7-flash", 90)]);
    expect(google.models).toEqual(["gemini-5-pro", "gemini-4-hydrogen", "gemini-3.7-flash"]);
    expect([...google.added]).toEqual(["gemini-5-pro", "gemini-3.7-flash"]);
    const claude = terminalModelsWithCatalog("claude", ["claude-fable-5-2"], [model("anthropic/claude-fable-5.2", 8), model("anthropic/claude-fable-5", 150)]);
    expect(claude.models).toEqual(["claude-fable-5-2", "claude-fable-5"]);
  });

  it("calls only the last 30 days' models new; older additions are listed without the tag", () => {
    const listed = studioModelsWithCatalog("google", [], [model("google/gemini-5-pro", 5), model("google/gemini-3.7-flash", 96)]);
    expect(listed.models).toEqual(["gemini-5-pro", "gemini-3.7-flash"]);
    expect([...listed.fresh]).toEqual(["gemini-5-pro"]);
  });
});

describe("newestCatalogModelIds", () => {
  it("lists the major makers' models that take tools from the last 60 days, newest first, at most 16", () => {
    const noTools = { ...model("openai/gpt-6.2", 3), tools: false };
    const ids = newestCatalogModelIds({
      fetchedAt: new Date(now * 1000).toISOString(),
      models: [...CATALOG, noTools, model("someone/obscure-1", 2), model("openai/gpt-6.1-terra", 59), model("openai/gpt-6.1-sol", 61)],
    });
    expect(ids).toEqual(["qwen/qwen4-max", "google/gemini-4-hydrogen", "anthropic/claude-fable-5.2", "deepseek/deepseek-v4.2", "google/gemini-4-argon", "openai/gpt-6.1-terra"]);
    const many = Array.from({ length: 20 }, (_, i) => model(`qwen/qwen4-${i}`, i + 1));
    expect(newestCatalogModelIds({ fetchedAt: null, models: many })).toEqual(many.slice(0, 16).map((m) => m.id));
  });

  it("counts back from when the catalog was downloaded, so an old catalog still has newest models", () => {
    const downloaded = now - 200 * 86_400;
    const old = [model("google/gemini-3.8-flash", 205), model("google/gemini-2.5-pro", 300)];
    expect(newestCatalogModelIds({ fetchedAt: new Date(downloaded * 1000).toISOString(), models: old })).toEqual(["google/gemini-3.8-flash"]);
  });

  it("is null without a catalog, so the picker keeps its own list", () => {
    expect(newestCatalogModelIds(undefined)).toBeNull();
    expect(newestCatalogModelIds({ fetchedAt: null, models: [] })).toBeNull();
  });
});
