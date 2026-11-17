import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as claudeFallbackModels } from "@paperclipai/adapter-claude-local";
import { resetClaudeModelsCacheForTests } from "@paperclipai/adapter-claude-local/server";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { models as opencodeFallbackModels } from "@paperclipai/adapter-opencode-local";
import { resetOpenCodeModelsCacheForTests } from "@paperclipai/adapter-opencode-local/server";
import { listAdapterModels, listServerAdapters, refreshAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";
import { configureModelCatalogForTests, resetModelCatalogForTests } from "../services/model-catalog.js";
import type { CatalogModel } from "@paperclipai/shared/model-catalog";

/** A model the public catalog lists, released `daysAgo` days ago. */
function catalogModel(id: string, name: string, daysAgo: number): CatalogModel {
  return { id, name, created: Math.floor(Date.now() / 1000) - daysAgo * 86_400, context: null, tools: true, input: ["text"], output: ["text"], price: null };
}

/** The catalog the lists see: fresh (no download), holding `models`. */
function useCatalog(models: CatalogModel[] = [], fetch: (...args: unknown[]) => unknown = () => { throw new Error("no catalog download expected"); }) {
  configureModelCatalogForTests({
    fetch: fetch as never,
    savedFile: () => null,
    builtIn: () => ({ source: "built-in", fetchedAt: new Date().toISOString(), models: [...models].sort((a, b) => b.created - a.created) }),
  });
}

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

describe("adapter model listing", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetClaudeModelsCacheForTests();
    resetCodexModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
    // An empty, fresh catalog: the lists are the adapters' own unless a test adds models.
    useCatalog();
  });
  afterEach(() => resetModelCatalogForTests());

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("does not expose models for the retired acpx_local tombstone", () => {
    const adapter = listServerAdapters().find((candidate) => candidate.type === "acpx_local");

    expect(adapter?.models).toEqual([]);
  });

  it("returns codex fallback models when no OpenAI key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    // The bare gpt-5.6 alias is intentionally not advertised (Codex has no metadata for it).
    expect(models.some((model) => model.id === "gpt-5.6")).toBe(false);
    expect(models.some((model) => model.id === "gpt-5.6-sol")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.6-terra")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.6-luna")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.3-codex-spark")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns claude fallback models including the latest Opus alias when no Anthropic key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("claude_local");

    expect(models).toEqual(claudeFallbackModels);
    expect(models.some((model) => model.id === "claude-opus-4-8")).toBe(true);
    // Newer flagship models are offered, but Opus 4.8 stays the default (first) option.
    expect(models[0]?.id).toBe("claude-opus-4-8");
    expect(models.some((model) => model.id === "claude-sonnet-5")).toBe(true);
    expect(models.some((model) => model.id === "claude-fable-5-1")).toBe(true);
    expect(models.some((model) => model.id === "claude-fable-5")).toBe(true);
    expect(models.some((model) => model.id === "claude-mythos-5")).toBe(true);
    // Opus 5 is a current GA flagship and must be offered even when live discovery is unavailable.
    expect(models.some((model) => model.id === "claude-opus-5")).toBe(true);
    expect(models).toContainEqual({ id: "claude-opus-5-5", label: "Claude Opus 5.5" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads claude models dynamically and merges fallback options", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4" },
          { id: "claude-opus-4-8-20260529", display_name: "Claude Opus 4.8" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("claude_local");
    const second = await listAdapterModels("claude_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "claude-opus-4-8-20260529")).toBe(true);
    expect(first.some((model) => model.id === "claude-opus-4-8")).toBe(true);
    expect(first.some((model) => model.id === "claude-opus-5-5")).toBe(true);
  });

  it("refreshes cached claude models on demand", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4" }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "claude-opus-4-8-20260529", display_name: "Claude Opus 4.8" }],
        }),
      } as Response);

    const initial = await listAdapterModels("claude_local");
    const refreshed = await refreshAdapterModels("claude_local");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(initial.some((model) => model.id === "claude-sonnet-4-20250514")).toBe(true);
    expect(refreshed.some((model) => model.id === "claude-opus-4-8-20260529")).toBe(true);
  });

  it("falls back to static claude models when Anthropic model discovery fails", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("claude_local");
    expect(models).toEqual(claudeFallbackModels);
  });

  it.each([
    ["claude-fable-5-1", "Claude Fable 5.1"],
    ["claude-opus-5-5", "Claude Opus 5.5"],
  ])("does not duplicate %s when discovery returns the identical ID", async (id, displayName) => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id, display_name: displayName }],
      }),
    } as Response);

    const models = await listAdapterModels("claude_local");

    expect(models.filter((model) => model.id === id)).toEqual([{ id, label: displayName }]);
    // Curated fallbacks discovery did not return are still merged in.
    expect(models.some((model) => model.id === "claude-fable-5")).toBe(true);
    expect(models.some((model) => model.id === "claude-opus-4-8")).toBe(true);
  });

  it("exposes the Bedrock-native Fable 5.1 ID (never the direct ID) in Bedrock mode", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const models = await listAdapterModels("claude_local");

    // Keep Opus 4.8 first, using its documented dateless Bedrock ID.
    expect(models[0]?.id).toBe("us.anthropic.claude-opus-4-8");
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "us.anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5", "us.anthropic.claude-sonnet-5",
      "us.anthropic.claude-fable-5-1", "us.anthropic.claude-opus-4-7", "us.anthropic.claude-sonnet-4-6",
    ]));
    expect(models.map((model) => model.id)).not.toEqual(expect.arrayContaining(["us.anthropic.claude-opus-4-8-v1"]));
    expect(models.some((model) => model.id === "claude-fable-5-1")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["gemini_local", ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview"]],
    ["grok_local", ["grok-build", "grok-4.7", "grok-4.6", "grok-4.5"]],
    ["kimi_local", ["kimi-code/kimi-for-coding", "kimi-code/k3", "kimi-code/k3-256k"]],
  ])("lists current %s models without a provider login", async (adapter, expectedIds) => {
    const models = await listAdapterModels(adapter as string);
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining(expectedIds as string[]));
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    if (adapter === "gemini_local") {
      expect(models.some((model) => model.id.startsWith("gemini-2.0-"))).toBe(false);
    }
    if (adapter === "kimi_local") {
      expect(models).toContainEqual({ id: "kimi-code/kimi-for-coding", label: "K2.8 Preview" });
    }
  });

  describe("with the public model catalog's newer models", () => {
    // Models from after this Automa was built: none of them is on a built-in list.
    const CATALOG = [
      catalogModel("google/gemini-5-pro", "Google: Gemini 5 Pro", 5),
      catalogModel("google/gemini-5-flash", "Google: Gemini 5 Flash", 7),
      catalogModel("google/gemini-nano-banana-3", "Google: Nano Banana 3", 6),
      catalogModel("google/gemini-4-argon", "Google: Gemini 4 Argon", 35),
      catalogModel("anthropic/claude-opus-6", "Anthropic: Claude Opus 6", 8),
      catalogModel("openai/gpt-7", "OpenAI: GPT-7", 22),
      catalogModel("x-ai/grok-4.8", "xAI: Grok 4.8", 3),
      catalogModel("x-ai/grok-2", "xAI: Grok 2", 700),
    ];

    it("lists new Gemini models after Auto, newest first, without picture models or ones it has", async () => {
      useCatalog(CATALOG);
      const ids = (await listAdapterModels("gemini_local")).map((model) => model.id);
      expect(ids.slice(0, 3)).toEqual(["auto", "gemini-5-pro", "gemini-5-flash"]);
      expect(ids.filter((id) => id === "gemini-4-argon")).toHaveLength(1);
      expect(ids).not.toContain("gemini-nano-banana-3");
      expect((await listAdapterModels("gemini_local"))[1]).toEqual({ id: "gemini-5-pro", label: "Gemini 5 Pro" });
    });

    it("places a model the list lacks by its release date, so the newest stay on top", async () => {
      const listed = (await listAdapterModels("gemini_local")).map((model) => model.id).filter((id) => id !== "auto");
      // Every listed model dated: Carbon 9 days old, Hydrogen 10, Argon 35, the others a year.
      const ages: Record<string, number> = { "gemini-4-carbon": 9, "gemini-4-hydrogen": 10, "gemini-4-argon": 35 };
      useCatalog([
        ...listed.map((id) => catalogModel(`google/${id}`, id, ages[id] ?? 365)),
        catalogModel("google/gemini-5-pro", "Google: Gemini 5 Pro", 5),
        catalogModel("google/gemini-3.9-pro", "Google: Gemini 3.9 Pro", 40),
      ]);
      const ids = (await listAdapterModels("gemini_local")).map((model) => model.id);
      expect(ids.slice(0, 2)).toEqual(["auto", "gemini-5-pro"]);
      // Out before Argon's month-old release and after the year-old models: just below Argon.
      expect(ids[ids.indexOf("gemini-4-argon") + 1]).toBe("gemini-3.9-pro");
      expect(ids).toHaveLength(listed.length + 3);
    });

    it("lists new Grok models after the default, and not old ones", async () => {
      useCatalog(CATALOG);
      const ids = (await listAdapterModels("grok_local")).map((model) => model.id);
      expect(ids.slice(0, 2)).toEqual(["grok-build", "grok-4.8"]);
      expect(ids).not.toContain("grok-2");
    });

    it("adds new Claude and OpenAI models after the default when no key reaches the provider's own list", async () => {
      useCatalog(CATALOG);
      const claude = (await listAdapterModels("claude_local")).map((model) => model.id);
      expect(claude.slice(0, 2)).toEqual(["claude-opus-4-8", "claude-opus-6"]);
      const codex = (await listAdapterModels("codex_local")).map((model) => model.id);
      expect(codex[0]).toBe(codexFallbackModels[0]!.id);
      expect(codex[1]).toBe("gpt-7");
    });

    it("leaves Anthropic's own list (a key reaches it) and Bedrock's ids as they are", async () => {
      useCatalog(CATALOG);
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] }),
      } as Response);
      expect((await listAdapterModels("claude_local")).some((model) => model.id === "claude-opus-6")).toBe(false);

      delete process.env.ANTHROPIC_API_KEY;
      resetClaudeModelsCacheForTests();
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      const bedrock = (await listAdapterModels("claude_local")).map((model) => model.id);
      expect(bedrock.every((id) => id.startsWith("us.anthropic."))).toBe(true);
    });

    it("downloads the catalog when the models are refreshed", async () => {
      const download = vi.fn(async () => Response.json({
        data: Array.from({ length: 60 }, (_, i) => i === 0
          ? { id: "google/gemini-5-ultra", name: "Google: Gemini 5 Ultra", created: Math.floor(Date.now() / 1000), architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] }
          : { id: `maker/model-${i}`, name: `Model ${i}`, created: Math.floor(Date.now() / 1000) - 400 * 86_400 }),
      }));
      useCatalog(CATALOG, download);
      expect((await listAdapterModels("gemini_local")).map((model) => model.id)).not.toContain("gemini-5-ultra");
      const refreshed = (await refreshAdapterModels("gemini_local")).map((model) => model.id);
      expect(download).toHaveBeenCalledTimes(1);
      expect(refreshed.slice(0, 2)).toEqual(["auto", "gemini-5-ultra"]);
    });
  });

  it("includes current Cursor fallbacks when runtime discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({ status: 1, stdout: "", stderr: "", hasError: true }));
    const models = await listAdapterModels("cursor");
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "composer-2.5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5",
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "grok-4.7", "gemini-3.8-flash", "muse-spark-1.3",
    ]));
  });

  it("loads codex models dynamically and merges fallback options", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5-pro")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
  });

  it("refreshes cached codex models on demand", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5" }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5.6-terra" }],
        }),
      } as Response);

    const initial = await listAdapterModels("codex_local");
    const refreshed = await refreshAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(initial.some((model) => model.id === "gpt-5")).toBe(true);
    expect(refreshed.some((model) => model.id === "gpt-5.6-terra")).toBe(true);
    expect(refreshed.some((model) => model.id === "gpt-5.6-luna")).toBe(true);
  });

  it("falls back to static codex models when OpenAI model discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });


  it("returns cursor fallback models when CLI discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));

    const models = await listAdapterModels("cursor");
    expect(models).toEqual(cursorFallbackModels);
  });

  it("returns current provider-qualified OpenCode models when discovery is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAdapterModels("opencode_local");

    expect(models).toEqual(opencodeFallbackModels);
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining(["openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna", "anthropic/claude-opus-5-5", "anthropic/claude-opus-5", "anthropic/claude-fable-5-1", "anthropic/claude-sonnet-5", "google/gemini-3.8-flash", "xai/grok-4.7"]));
  });

  it("loads cursor models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: auto, composer-1.5, gpt-5.3-codex-high, sonnet-4.6",
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const first = await listAdapterModels("cursor");
    const second = await listAdapterModels("cursor");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "auto")).toBe(true);
    expect(first.some((model) => model.id === "gpt-5.3-codex-high")).toBe(true);
    expect(first.some((model) => model.id === "composer-1")).toBe(true);
  });

  describe("PAPERCLIP_ADAPTER_MODELS declared models", () => {
    afterEach(() => {
      delete process.env.PAPERCLIP_ADAPTER_MODELS;
    });

    it("prefers declared env models over adapter discovery", async () => {
      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        opencode_local: [
          { id: "tensorix/deepseek/deepseek-chat-v3.1", label: "DeepSeek v3.1" },
          { id: "tensorix/z-ai/glm-4.7" },
        ],
      });

      const models = await listAdapterModels("opencode_local");

      expect(models).toEqual([
        { id: "tensorix/deepseek/deepseek-chat-v3.1", label: "DeepSeek v3.1" },
        { id: "tensorix/z-ai/glm-4.7", label: "tensorix/z-ai/glm-4.7" },
      ]);
    });

    it("observes env changes between calls (memo keyed by raw env value)", async () => {
      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        opencode_local: [{ id: "model-a" }],
      });
      expect(await listAdapterModels("opencode_local")).toEqual([
        { id: "model-a", label: "model-a" },
      ]);

      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        opencode_local: [{ id: "model-b" }],
      });
      expect(await listAdapterModels("opencode_local")).toEqual([
        { id: "model-b", label: "model-b" },
      ]);
    });

    it("fails soft on malformed values: falls back to adapter models instead of throwing", async () => {
      process.env.PAPERCLIP_ADAPTER_MODELS = "{not json";
      process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const models = await listAdapterModels("opencode_local");
      expect(models).toEqual(opencodeFallbackModels);

      // Parsing is memoized per raw value: a second call must not re-log.
      const callsAfterFirst = errorSpy.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);
      await listAdapterModels("opencode_local");
      expect(errorSpy.mock.calls.length).toBe(callsAfterFirst);
    });

    it("ignores declared models for adapters not in the map", async () => {
      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        opencode_local: [{ id: "model-a" }],
      });
      const models = await listAdapterModels("codex_local");
      expect(models).toEqual(codexFallbackModels);
    });
  });
});
