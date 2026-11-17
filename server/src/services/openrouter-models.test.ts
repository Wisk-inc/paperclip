import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CatalogModel } from "@paperclipai/shared/model-catalog";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const HOUR = 60 * 60_000;

function model(id: string, name: string): CatalogModel {
  return { id, name, created: NOW / 1000, context: null, tools: true, input: ["text"], output: ["text"], price: null };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

async function setUp(fetch: ReturnType<typeof vi.fn>) {
  const catalog = await import("./model-catalog.js");
  catalog.configureModelCatalogForTests({
    fetch: fetch as never,
    savedFile: () => null,
    now: () => NOW,
    builtIn: () => ({ source: "built-in", fetchedAt: new Date(NOW - HOUR).toISOString(), models: [model("x-ai/grok-4.7", "xAI: Grok 4.7"), model("anthropic/claude-sonnet-4.5", "Anthropic: Claude Sonnet 4.5")] }),
  });
  return import("./openrouter-models.js");
}

it("lists every model in the catalog as OpenCode names them, sorted by name, without downloading a fresh catalog", async () => {
  const fetch = vi.fn();
  const { listOpenRouterModels } = await setUp(fetch);
  expect(await listOpenRouterModels()).toEqual([
    { id: "openrouter/anthropic/claude-sonnet-4.5", label: "Anthropic: Claude Sonnet 4.5" },
    { id: "openrouter/x-ai/grok-4.7", label: "xAI: Grok 4.7" },
  ]);
  expect(fetch).not.toHaveBeenCalled();
});

it("downloads the catalog when asked to refresh, and keeps the list it had when that fails", async () => {
  const fetch = vi.fn()
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce(Response.json({ data: Array.from({ length: 60 }, (_, i) => ({ id: `maker/model-${i}`, name: `Model ${i}`, created: NOW / 1000 - i })) }));
  const { listOpenRouterModels } = await setUp(fetch);
  expect((await listOpenRouterModels(true)).map((m) => m.id)).toEqual(["openrouter/anthropic/claude-sonnet-4.5", "openrouter/x-ai/grok-4.7"]);
  // No credentials: the public catalog, with a deadline and nothing else.
  expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", { signal: expect.any(AbortSignal) });
  expect(await listOpenRouterModels(true)).toHaveLength(60);
  expect(fetch).toHaveBeenCalledTimes(2);
});
