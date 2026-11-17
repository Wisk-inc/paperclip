import { describe, expect, it } from "vitest";
import {
  catalogLabel,
  catalogNativeId,
  catalogReleaseDates,
  isCatalogChatModel,
  newCatalogModels,
  parseCatalogModels,
  placeCatalogModels,
  withNewCatalogModels,
  type CatalogModel,
} from "./model-catalog.js";

const DAY = 86_400;
const NOW = Date.UTC(2026, 10, 17) / 1000;

function entry(id: string, daysAgo: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Maker: ${id.split("/")[1]}`,
    created: NOW - daysAgo * DAY,
    context_length: 1_000_000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools", "temperature"],
    pricing: { prompt: "0.000002", completion: "0.00001" },
    ...extra,
  };
}

function model(id: string, daysAgo: number, output = ["text"]): CatalogModel {
  return { id, name: id, created: NOW - daysAgo * DAY, context: null, tools: true, input: ["text"], output, price: null };
}

describe("parseCatalogModels", () => {
  it("reads every field and lists the newest first", () => {
    const models = parseCatalogModels({
      data: [
        entry("google/gemini-4-argon", 35),
        entry("google/gemini-4-hydrogen", 5, { name: "Google: Gemini 4 Hydrogen" }),
        entry("openrouter/free", 60, { pricing: { prompt: "0", completion: "0" }, supported_parameters: [] }),
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["google/gemini-4-hydrogen", "google/gemini-4-argon", "openrouter/free"]);
    expect(models[0]).toEqual({
      id: "google/gemini-4-hydrogen",
      name: "Google: Gemini 4 Hydrogen",
      created: NOW - 5 * DAY,
      context: 1_000_000,
      tools: true,
      input: ["text"],
      output: ["text"],
      price: { input: 0.000002, output: 0.00001 },
    });
    // A model with no price has none, rather than a price of zero.
    expect(models[2]).toMatchObject({ tools: false, price: null });
  });

  it("drops entries it cannot use and refuses an answer without a list", () => {
    const models = parseCatalogModels({
      data: [null, "text", { id: "no-maker", created: NOW }, { id: "a/b" }, entry("a/kept", 1, { architecture: null, pricing: null })],
    });
    expect(models.map((m) => m.id)).toEqual(["a/kept"]);
    expect(models[0]).toMatchObject({ input: [], output: [], price: null });
    expect(() => parseCatalogModels({ error: "rate limited" })).toThrow(/without a model list/);
    expect(() => parseCatalogModels(null)).toThrow(/without a model list/);
  });
});

describe("isCatalogChatModel", () => {
  it("keeps chat models and drops variants and models for pictures, sound or search", () => {
    const chat = ["google/gemini-4-hydrogen", "google/gemini-omni-1.2-flash", "anthropic/claude-fable-5.2", "qwen/qwen4-max", "openai/gpt-6.1-terra"];
    for (const id of chat) expect(isCatalogChatModel(model(id, 1)), id).toBe(true);
    const notChat = [
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "openai/gpt-6.1-terra:batch",
      "google/gemini-nano-banana-2.1",
      "google/gemini-3.8-flash-image",
      "google/lyria-3-pro-preview",
      "openai/gpt-6-tts",
      "openai/gpt-6.1-realtime",
      "openai/text-embedding-4-large",
      "meta-llama/llama-guard-4-12b",
    ];
    for (const id of notChat) expect(isCatalogChatModel(model(id, 1)), id).toBe(false);
    expect(isCatalogChatModel(model("google/imagine-1", 1, ["image"]))).toBe(false);
  });
});

describe("catalogNativeId", () => {
  it("writes each list's own ids", () => {
    expect(catalogNativeId("anthropic", "anthropic/claude-fable-5.2")).toBe("claude-fable-5-2");
    expect(catalogNativeId("anthropic", "anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(catalogNativeId("anthropic", "openai/gpt-6.1-terra")).toBeNull();
    expect(catalogNativeId("openai", "openai/gpt-6.1-terra-pro")).toBe("gpt-6.1-terra-pro");
    expect(catalogNativeId("openai", "openai/o5-mini")).toBe("o5-mini");
    expect(catalogNativeId("openai", "openai/gpt-oss-240b")).toBeNull();
    expect(catalogNativeId("google", "google/gemini-4-hydrogen")).toBe("gemini-4-hydrogen");
    expect(catalogNativeId("google", "google/gemma-4-31b-it")).toBeNull();
    expect(catalogNativeId("xai", "x-ai/grok-4.7")).toBe("grok-4.7");
    expect(catalogNativeId("moonshot", "moonshotai/kimi-k3.1-pro")).toBe("kimi-k3.1-pro");
    expect(catalogNativeId("openrouter", "qwen/qwen4-max")).toBe("qwen/qwen4-max");
    expect(catalogNativeId("openrouter", "someone/obscure-1")).toBeNull();
    expect(catalogNativeId("google", "no-slash")).toBeNull();
  });
});

describe("catalogLabel", () => {
  it("drops the maker from the catalog's name", () => {
    expect(catalogLabel({ id: "google/gemini-4-hydrogen", name: "Google: Gemini 4 Hydrogen" })).toBe("Gemini 4 Hydrogen");
    expect(catalogLabel({ id: "a/b", name: "Plain" })).toBe("Plain");
  });
});

describe("newCatalogModels and withNewCatalogModels", () => {
  const catalog = [
    model("google/gemini-4-hydrogen", 5),
    model("google/gemini-4-carbon", 7),
    model("google/gemini-nano-banana-2.1", 8),
    model("google/gemini-omni-1.2-flash", 12),
    model("google/gemini-4-argon", 35),
    model("google/gemini-2.0-flash", 400),
    model("anthropic/claude-fable-5.2", 8),
  ].sort((a, b) => b.created - a.created);

  it("lists what the list lacks, released within the window, newest first", () => {
    const found = newCatalogModels("google", ["gemini-4-argon", "gemini-4-carbon"], catalog, { now: NOW * 1000 });
    expect(found.map((m) => m.id)).toEqual(["gemini-4-hydrogen", "gemini-omni-1.2-flash"]);
    expect(found[0]).toMatchObject({ label: "google/gemini-4-hydrogen", created: NOW - 5 * DAY });
  });

  it("leaves out models that cannot call tools", () => {
    const noTools = { ...model("google/gemini-omni-1.2-flash", 3), tools: false };
    const withoutTools = [noTools, ...catalog.filter((m) => m.id !== noTools.id)];
    const ids = newCatalogModels("google", [], withoutTools, { now: NOW * 1000 }).map((m) => m.id);
    expect(ids).not.toContain("gemini-omni-1.2-flash");
    expect(ids).toContain("gemini-4-hydrogen");
  });

  it("honours the window and the limit", () => {
    expect(newCatalogModels("google", [], catalog, { now: NOW * 1000, days: 6 }).map((m) => m.id)).toEqual(["gemini-4-hydrogen"]);
    expect(newCatalogModels("google", [], catalog, { now: NOW * 1000, limit: 2 }).map((m) => m.id)).toEqual(["gemini-4-hydrogen", "gemini-4-carbon"]);
    expect(newCatalogModels("google", [], catalog, { now: NOW * 1000, days: 1000 }).map((m) => m.id)).toContain("gemini-2.0-flash");
  });

  it("puts the new ones in front and keeps the list as it was", () => {
    expect(withNewCatalogModels("anthropic", ["claude-opus-5-5", "claude-fable-5-1"], catalog, { now: NOW * 1000 })).toEqual([
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-fable-5-1",
    ]);
    // Nothing new: the list as it was.
    expect(withNewCatalogModels("xai", ["grok-4.7"], catalog, { now: NOW * 1000 })).toEqual(["grok-4.7"]);
  });

  it("places each model above the first listed one that came out before it, and older ones at the end", () => {
    // Hydrogen (5 days) came out after Carbon (7 days); Omni (12) and Argon (35) before it.
    expect(withNewCatalogModels("google", ["gemini-4-carbon"], catalog, { now: NOW * 1000 })).toEqual([
      "gemini-4-hydrogen",
      "gemini-4-carbon",
      "gemini-omni-1.2-flash",
      "gemini-4-argon",
    ]);
    // Between Hydrogen (5) and Argon (35): Carbon (7) and Omni (12).
    expect(withNewCatalogModels("google", ["gemini-4-hydrogen", "gemini-4-argon"], catalog, { now: NOW * 1000 })).toEqual([
      "gemini-4-hydrogen",
      "gemini-4-carbon",
      "gemini-omni-1.2-flash",
      "gemini-4-argon",
    ]);
  });

  it("counts a listed model the catalog does not date as older, so a new model still lands on top", () => {
    expect(withNewCatalogModels("google", ["gemini-4-custom", "gemini-4-argon"], catalog, { now: NOW * 1000 })).toEqual([
      "gemini-4-hydrogen",
      "gemini-4-carbon",
      "gemini-omni-1.2-flash",
      "gemini-4-custom",
      "gemini-4-argon",
    ]);
  });
});

describe("catalogReleaseDates", () => {
  it("dates each model by its id in the list's own form", () => {
    const dates = catalogReleaseDates("anthropic", [model("anthropic/claude-fable-5.2", 8), model("google/gemini-4-argon", 35)]);
    expect([...dates]).toEqual([["claude-fable-5-2", NOW - 8 * DAY]]);
  });
});

describe("placeCatalogModels", () => {
  const added = [
    { id: "older", label: "Older", created: NOW - 90 * DAY },
    { id: "newest", label: "Newest", created: NOW - DAY },
  ];
  const released = new Map([["auto", NOW], ["listed", NOW - 30 * DAY]]);

  it("keeps the first entries on top and places the rest by release date, newest first", () => {
    expect(placeCatalogModels(["auto", "listed"], added, { id: (id) => id, entry: (m) => m.id, released, keepFirst: 1 })).toEqual(["auto", "newest", "listed", "older"]);
    expect(placeCatalogModels([{ id: "listed" }], added, { id: (item) => item.id, entry: (m) => ({ id: m.id }), released })).toEqual([{ id: "newest" }, { id: "listed" }, { id: "older" }]);
  });

  it("leaves the list as it was when nothing is added", () => {
    const list = ["auto", "listed"];
    const placed = placeCatalogModels(list, [], { id: (id) => id, entry: (m) => m.id, released, keepFirst: 1 });
    expect(placed).toEqual(list);
    expect(placed).not.toBe(list);
  });
});
