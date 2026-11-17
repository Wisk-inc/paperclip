import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogModel, ModelCatalogSnapshot } from "@paperclipai/shared/model-catalog";
import {
  MODEL_CATALOG_URL,
  configureModelCatalogForTests,
  getModelCatalog,
  refreshModelCatalog,
  resetModelCatalogForTests,
} from "./model-catalog.js";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-17T12:00:00Z");

function model(id: string, created = NOW / 1000): CatalogModel {
  return { id, name: id, created, context: null, tools: true, input: ["text"], output: ["text"], price: null };
}

function builtIn(ageMs: number, ids = ["google/gemini-4-argon"]): ModelCatalogSnapshot {
  return { source: "built-in", fetchedAt: new Date(NOW - ageMs).toISOString(), models: ids.map((id) => model(id)) };
}

/** A catalog answer with `count` models, the newest first being `newest`. */
function answer(count: number, newest = "google/gemini-4-hydrogen") {
  return Response.json({
    data: Array.from({ length: count }, (_, i) => ({
      id: i === 0 ? newest : `maker/model-${i}`,
      name: i === 0 ? "Google: Gemini 4 Hydrogen" : `Model ${i}`,
      created: NOW / 1000 - i * 60,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    })),
  });
}

describe("the model catalog", () => {
  let dir: string;
  let now: number;
  let savedFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "model-catalog-"));
    savedFile = path.join(dir, "data", "model-catalog.json");
    now = NOW;
  });
  afterEach(() => {
    resetModelCatalogForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  function setUp(options: { fetch: ReturnType<typeof vi.fn>; builtIn?: ModelCatalogSnapshot }) {
    configureModelCatalogForTests({
      fetch: options.fetch as never,
      savedFile: () => savedFile,
      now: () => now,
      builtIn: () => options.builtIn ?? builtIn(13 * HOUR),
    });
  }

  it("answers at once with the built-in catalog, downloads a new one in the background when it is over 12 hours old, and saves it", async () => {
    const fetch = vi.fn(async () => answer(60));
    setUp({ fetch });
    const first = getModelCatalog();
    expect(first.source).toBe("built-in");
    expect(first.models.map((m) => m.id)).toEqual(["google/gemini-4-argon"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    // No credentials: the public catalog, with a deadline and nothing else.
    expect(fetch).toHaveBeenCalledWith(MODEL_CATALOG_URL, { signal: expect.any(AbortSignal) });

    await vi.waitFor(() => expect(getModelCatalog().source).toBe("live"));
    const live = getModelCatalog();
    expect(live.models).toHaveLength(60);
    expect(live.models[0]).toMatchObject({ id: "google/gemini-4-hydrogen", name: "Google: Gemini 4 Hydrogen" });
    expect(live.fetchedAt).toBe(new Date(NOW).toISOString());
    const saved = JSON.parse(readFileSync(savedFile, "utf8"));
    expect(saved.fetchedAt).toBe(live.fetchedAt);
    expect(saved.models).toHaveLength(60);
    // Fresh now: no further download.
    getModelCatalog();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not download while the catalog is under 12 hours old", () => {
    const fetch = vi.fn(async () => answer(60));
    setUp({ fetch, builtIn: builtIn(11 * HOUR) });
    expect(getModelCatalog().source).toBe("built-in");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("after a restart uses its saved copy, and skips one older than the built-in catalog", () => {
    const fetch = vi.fn(async () => answer(60));
    mkdirSync(path.dirname(savedFile), { recursive: true });
    writeFileSync(savedFile, JSON.stringify({ fetchedAt: new Date(NOW - HOUR).toISOString(), models: [model("google/gemini-4-carbon")] }));
    setUp({ fetch, builtIn: builtIn(5 * HOUR) });
    const restarted = getModelCatalog();
    expect(restarted.source).toBe("saved");
    expect(restarted.models.map((m) => m.id)).toEqual(["google/gemini-4-carbon"]);
    expect(fetch).not.toHaveBeenCalled();

    // An Automa update shipped a newer catalog than the copy.
    setUp({ fetch, builtIn: builtIn(30 * 60_000, ["google/gemini-4-hydrogen"]) });
    expect(getModelCatalog()).toMatchObject({ source: "built-in", models: [{ id: "google/gemini-4-hydrogen" }] });
  });

  it("ignores a damaged saved copy", () => {
    mkdirSync(path.dirname(savedFile), { recursive: true });
    writeFileSync(savedFile, "{\"fetchedAt\":\"2026-11-17T11:");
    setUp({ fetch: vi.fn(async () => answer(60)), builtIn: builtIn(HOUR) });
    expect(getModelCatalog().source).toBe("built-in");
  });

  it("keeps what it had when a download fails, and waits 10 minutes before trying again", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    setUp({ fetch });
    expect((await refreshModelCatalog()).source).toBe("built-in");
    now += 5 * 60_000;
    getModelCatalog();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 5 * 60_000;
    getModelCatalog();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a broken answer: an error status, or too few models to be a catalog", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(answer(3));
    setUp({ fetch });
    expect((await refreshModelCatalog()).source).toBe("built-in");
    expect((await refreshModelCatalog()).models.map((m) => m.id)).toEqual(["google/gemini-4-argon"]);
    expect(() => readFileSync(savedFile)).toThrow();
  });

  it("downloads once when asked twice at the same time", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    setUp({ fetch, builtIn: builtIn(HOUR) });
    const both = Promise.all([refreshModelCatalog(), refreshModelCatalog()]);
    finish(answer(60));
    const [a, b] = await both;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.source).toBe("live");
  });
});
