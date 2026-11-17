import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogModel, ModelCatalogSnapshot } from "@paperclipai/shared/model-catalog";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-17T12:00:00Z");

function priced(id: string, price: CatalogModel["price"]): CatalogModel {
  return { id, name: id, created: NOW / 1000, context: null, tools: true, input: ["text"], output: ["text"], price };
}

const MODELS = [
  priced("deepseek/deepseek-v4.1-flash", { input: 0.0000002, output: 0.0000008 }),
  priced("deepseek/deepseek-v4.1-flash:free", null),
];

function snapshot(ageMs: number, models = MODELS): ModelCatalogSnapshot {
  return { source: "built-in", fetchedAt: new Date(NOW - ageMs).toISOString(), models };
}

// The free-models module and the catalog it reads are loaded fresh for each test.
beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The catalog module the next free-models import will read, set up for the test. */
async function catalogWith(options: { builtIn: ModelCatalogSnapshot; fetch: ReturnType<typeof vi.fn> }) {
  const catalog = await import("./model-catalog.js");
  catalog.configureModelCatalogForTests({ fetch: options.fetch as never, savedFile: () => null, now: () => NOW, builtIn: () => options.builtIn });
  return catalog;
}

describe("equivalent cost of free usage", () => {
  it("prices a free model at its paid version's list price, and one with no paid listing at the fallback rate", async () => {
    const fetch = vi.fn();
    await catalogWith({ builtIn: snapshot(HOUR), fetch });
    const { equivalentImageCostUsd, equivalentTokenCostUsd } = await import("./free-models.js");
    expect(await equivalentTokenCostUsd("deepseek/deepseek-v4.1-flash:free", { inputTokens: 1_000, outputTokens: 500 })).toBeCloseTo(0.0006, 12);
    expect(await equivalentTokenCostUsd("thinkingmachines/inkling:free", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.5, 12);
    expect(equivalentImageCostUsd(3)).toBeCloseTo(0.006, 12);
    // A catalog under 12 hours old: nothing downloaded.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the prices it has when the catalog can't be reached", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await catalogWith({ builtIn: snapshot(13 * HOUR), fetch });
    const { equivalentTokenCostUsd } = await import("./free-models.js");
    const usage = { inputTokens: 1_000, outputTokens: 500 };
    expect(await equivalentTokenCostUsd("deepseek/deepseek-v4.1-flash:free", usage)).toBeCloseTo(0.0006, 12);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(await equivalentTokenCostUsd("deepseek/deepseek-v4.1-flash:free", usage)).toBeCloseTo(0.0006, 12);
  });

  it("prices with the newer catalog once it has downloaded", async () => {
    const fetch = vi.fn(async () => Response.json({
      data: Array.from({ length: 60 }, (_, i) => i === 0
        ? { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek", created: NOW / 1000, pricing: { prompt: "0.0000004", completion: "0.0000016" } }
        : { id: `maker/model-${i}`, name: `Model ${i}`, created: NOW / 1000 - i }),
    }));
    const catalog = await catalogWith({ builtIn: snapshot(13 * HOUR), fetch });
    const { equivalentTokenCostUsd } = await import("./free-models.js");
    const usage = { inputTokens: 1_000, outputTokens: 500 };
    expect(await equivalentTokenCostUsd("deepseek/deepseek-v4.1-flash:free", usage)).toBeCloseTo(0.0006, 12);
    await catalog.refreshModelCatalog();
    expect(await equivalentTokenCostUsd("deepseek/deepseek-v4.1-flash:free", usage)).toBeCloseTo(0.0012, 12);
  });
});
