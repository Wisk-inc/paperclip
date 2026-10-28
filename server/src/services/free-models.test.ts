import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CATALOG = {
  data: [
    { id: "deepseek/deepseek-v4.1-flash", pricing: { prompt: "0.0000002", completion: "0.0000008" } },
    { id: "deepseek/deepseek-v4.1-flash:free", pricing: { prompt: "0", completion: "0" } },
  ],
};

// The price list is cached for the server's life: each test loads a fresh copy of the module.
beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("equivalent cost of free usage", () => {
  it("prices a free model at its paid version's list price, and one with no paid listing at the fallback rate", async () => {
    const catalog = vi.fn(async () => Response.json(CATALOG));
    vi.stubGlobal("fetch", catalog);
    const { equivalentImageCostUsd, equivalentTokenCostUsd } = await import("./free-models.js");
    expect(await equivalentTokenCostUsd("deepseek/deepseek-v4.1-flash:free", { inputTokens: 1_000, outputTokens: 500 })).toBeCloseTo(0.0006, 12);
    expect(await equivalentTokenCostUsd("thinkingmachines/inkling:free", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.5, 12);
    expect(equivalentImageCostUsd(3)).toBeCloseTo(0.006, 12);
    expect(catalog).toHaveBeenCalledTimes(1);
  });

  it("keeps the prices it has when the catalog can't be reached", async () => {
    let now = Date.parse("2026-10-28T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const catalog = vi.fn(async () => Response.json(CATALOG));
    vi.stubGlobal("fetch", catalog);
    const { equivalentTokenCostUsd } = await import("./free-models.js");
    const usage = { inputTokens: 1_000, outputTokens: 500 };
    expect(await equivalentTokenCostUsd("deepseek/deepseek-v4.1-flash:free", usage)).toBeCloseTo(0.0006, 12);
    now += 7 * 60 * 60_000;
    catalog.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await equivalentTokenCostUsd("deepseek/deepseek-v4.1-flash:free", usage)).toBeCloseTo(0.0006, 12);
    expect(catalog).toHaveBeenCalledTimes(2);
  });
});
