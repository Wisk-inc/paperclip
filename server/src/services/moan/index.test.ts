import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ingestSource, knowledgeStats, pruneKnowledge } = vi.hoisted(() => ({ ingestSource: vi.fn(), knowledgeStats: vi.fn(), pruneKnowledge: vi.fn() }));

vi.mock("./store.js", () => ({
  knowledgeStats,
  pruneKnowledge,
  recentKnowledge: vi.fn(async () => []),
  searchAnyWord: vi.fn(async () => []),
  searchKnowledge: vi.fn(async () => []),
}));
vi.mock("./ingest.js", () => ({ ingestSource }));

import { moanKnowledge } from "./index.js";
import { MOAN_SOURCES } from "./sources.js";

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("Moan knowledge service", () => {
  it("keeps the server up when the first refresh of an empty index cannot read the database", async () => {
    vi.stubEnv("PAPERCLIP_MOAN_KNOWLEDGE", "on");
    knowledgeStats
      .mockResolvedValueOnce({ pages: 0, chunks: 0, lastFetchedAt: null, sources: [] })
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = await moanKnowledge({} as never).contextFor("minimum wage");
      expect(result).toEqual({ context: "", freshness: "no pages yet; the Jamaican sources are being read in the background" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(knowledgeStats).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("prunes the index at the end of each refresh: a year of news, the listed sources' reference pages, a row cap", async () => {
    knowledgeStats.mockResolvedValue({ pages: 0, chunks: 0, lastFetchedAt: null, sources: [] });
    ingestSource.mockImplementation(async (_db: unknown, source: { id: string }) => ({ sourceId: source.id, items: 1, stored: 1, error: null }));
    pruneKnowledge.mockResolvedValue(3);

    expect(await moanKnowledge({} as never).refresh({ force: true })).toEqual({ started: true, sources: MOAN_SOURCES.length });
    await vi.waitFor(() => expect(pruneKnowledge).toHaveBeenCalledTimes(1));

    expect(ingestSource).toHaveBeenCalledTimes(MOAN_SOURCES.length);
    expect(pruneKnowledge.mock.invocationCallOrder[0]).toBeGreaterThan(ingestSource.mock.invocationCallOrder.at(-1)!);
    const rules = pruneKnowledge.mock.calls[0]![1] as { listed: string[]; feeds: string[]; newsBefore: Date; maxRows: number };
    expect(rules.listed).toEqual(MOAN_SOURCES.map((source) => source.id));
    expect(rules.feeds).toEqual(MOAN_SOURCES.filter((source) => source.kind === "rss").map((source) => source.id));
    expect((Date.now() - rules.newsBefore.getTime()) / (24 * 60 * 60_000)).toBeCloseTo(365, 0);
    expect(rules.maxRows).toBeGreaterThan(0);
  });
});
