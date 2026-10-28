import { afterEach, describe, expect, it, vi } from "vitest";

const { knowledgeStats } = vi.hoisted(() => ({ knowledgeStats: vi.fn() }));

vi.mock("./store.js", () => ({
  knowledgeStats,
  recentKnowledge: vi.fn(async () => []),
  searchAnyWord: vi.fn(async () => []),
  searchKnowledge: vi.fn(async () => []),
}));
vi.mock("./ingest.js", () => ({ ingestSource: vi.fn() }));

import { moanKnowledge } from "./index.js";

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
});
