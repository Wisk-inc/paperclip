// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOAN_MODEL_ID, STUDIO_AI_PROVIDER_INFO, resolveFreeModel, type FreeModelHealthEntry, type FreeModelHealthMap } from "@paperclipai/shared";
import type { ModelCatalogSnapshot } from "@paperclipai/shared/model-catalog";
import { freeHealthNote } from "@/components/agent-chat/ModelPickerSheet";
import { StudioModelSheet } from "./StudioModelSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The catalog the server keeps; empty unless a test fills it.
const catalogApi = vi.hoisted(() => ({ get: vi.fn(async (): Promise<ModelCatalogSnapshot> => ({ source: "built-in", fetchedAt: null, models: [] })) }));
vi.mock("@/api/modelCatalog", () => ({ modelCatalogApi: catalogApi }));
// Which free models answer; every one of them unless a test says otherwise.
const freeModels = vi.hoisted(() => ({ health: vi.fn(async (): Promise<FreeModelHealthMap> => ({})) }));
vi.mock("@/api/free-models", () => ({ freeModelsApi: freeModels }));

describe("StudioModelSheet", () => {
  beforeEach(() => {
    freeModels.health.mockReset();
    freeModels.health.mockResolvedValue({});
  });

  it("keeps the model name box for a custom provider after the first letter", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    // The sheet reads the OpenRouter catalog through a query, so it needs a client.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const draw = (model: string) =>
      act(async () => root.render(
        <QueryClientProvider client={client}>
          <StudioModelSheet provider="custom" model={model} keys={[]} onChange={onChange} />
        </QueryClientProvider>,
      ));
    try {
      await draw("");
      await act(async () => (container.querySelector('[data-testid="studio-model-button"]') as HTMLButtonElement).click());
      expect(document.body.querySelector('input[aria-label="Model name"]')).not.toBeNull();
      await draw("l");
      const input = document.body.querySelector('input[aria-label="Model name"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input!.value).toBe("l");
      expect(document.body.querySelector('[role="radiogroup"][aria-label="Model"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("never says the free models need a key, also before the key list arrives", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => root.render(
        <QueryClientProvider client={client}>
          <StudioModelSheet provider="free" model="nvidia/nemotron-3-ultra-550b-a55b:free" keys={[]} onChange={vi.fn()} team={[{ provider: "free", model: "nvidia/nemotron-3.5-lightning:free" }]} onTeamChange={vi.fn()} />
        </QueryClientProvider>,
      ));
      const button = container.querySelector('[data-testid="studio-model-button"]') as HTMLButtonElement;
      expect(button.textContent).toContain("No key needed");
      expect(button.textContent).not.toContain("Add a key");
      await act(async () => button.click());
      expect(document.body.querySelector('[data-provider="free"]')?.textContent).toContain("No key needed");
      expect(document.body.querySelector('[data-testid="studio-teammate"]')?.textContent).not.toContain("needs a key");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("shows models released after this Automa, from the catalog the server keeps, first and marked New", async () => {
    const created = Math.floor(Date.now() / 1000) - 5 * 86_400;
    catalogApi.get.mockResolvedValueOnce({
      source: "live",
      fetchedAt: new Date().toISOString(),
      models: [{ id: "google/gemini-5-pro", name: "Google: Gemini 5 Pro", created, context: 1_000_000, tools: true, input: ["text"], output: ["text"], price: null }],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => root.render(
        <QueryClientProvider client={client}>
          <StudioModelSheet provider="google" model="gemini-4-argon" keys={[]} onChange={vi.fn()} />
        </QueryClientProvider>,
      ));
      await act(async () => (container.querySelector('[data-testid="studio-model-button"]') as HTMLButtonElement).click());
      await vi.waitFor(() => expect(document.body.querySelector('[data-model-id="gemini-5-pro"]')).not.toBeNull());
      const rows = [...document.body.querySelectorAll<HTMLElement>("[data-model-id]")].map((row) => row.dataset.modelId);
      expect(rows[0]).toBe("gemini-5-pro");
      expect(rows).toContain("gemini-4-argon");
      expect(document.body.querySelector('[data-model-id="gemini-5-pro"] [data-testid="studio-model-new"]')?.textContent).toBe("New");
      expect(document.body.querySelector('[data-model-id="gemini-4-argon"] [data-testid="studio-model-new"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("keeps one height whatever the provider lists, so it does not move under the thumb; the list scrolls inside", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const draw = (provider: "free" | "custom", model: string) =>
      act(async () => root.render(
        <QueryClientProvider client={client}>
          <StudioModelSheet provider={provider} model={model} keys={[]} onChange={vi.fn()} />
        </QueryClientProvider>,
      ));
    try {
      await draw("free", STUDIO_AI_PROVIDER_INFO.free.defaultModel);
      await act(async () => (container.querySelector('[data-testid="studio-model-button"]') as HTMLButtonElement).click());
      // A long list and a provider with no list at all: the same sheet height for both.
      for (const [provider, model] of [["free", STUDIO_AI_PROVIDER_INFO.free.defaultModel], ["custom", ""]] as const) {
        await draw(provider, model);
        const sheet = document.body.querySelector<HTMLElement>('[data-testid="studio-model-sheet"]')!;
        expect(sheet.classList.contains("h-(--sz-85vh)")).toBe(true);
        expect([...sheet.classList].some((name) => name.startsWith("max-h-"))).toBe(false);
        const body = sheet.querySelector<HTMLElement>('[role="radiogroup"][aria-label="AI provider"]')!.parentElement!;
        for (const name of ["min-h-0", "flex-1", "overflow-y-auto"]) expect(body.classList.contains(name)).toBe(true);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  describe("free models that are not answering", () => {
    const USUAL = STUDIO_AI_PROVIDER_INFO.free.defaultModel;
    const [BUSY, OFFLINE, ANSWERS, NEVER_ASKED] = STUDIO_AI_PROVIDER_INFO.free.models.filter(
      (id) => id !== USUAL && resolveFreeModel(id).puterModel === id,
    ) as [string, string, string, string];
    const iso = (fromNowMs: number) => new Date(Date.now() + fromNowMs).toISOString();
    const held = (state: FreeModelHealthEntry["state"], forMs: number): FreeModelHealthEntry => ({ state, until: iso(forMs), checkedAt: iso(-5_000), last: state });
    /** Waits for what the findings put on screen; each try leaves act, so the updates it queued are drawn. */
    const settle = async (check: () => void) => {
      let failure: unknown;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          check();
          return;
        } catch (error) {
          failure = error;
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        }
      }
      throw failure;
    };
    const row = (id: string) => document.body.querySelector<HTMLElement>(`[data-model-id="${id}"]`);
    const mark = (id: string) => row(id)?.querySelector<HTMLElement>('[data-slot="model-health"]') ?? null;

    async function open(props: Partial<Parameters<typeof StudioModelSheet>[0]> = {}) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await act(async () => root.render(
        <QueryClientProvider client={client}>
          <StudioModelSheet provider="free" model={USUAL} keys={[]} onChange={vi.fn()} {...props} />
        </QueryClientProvider>,
      ));
      await act(async () => (container.querySelector('[data-testid="studio-model-button"]') as HTMLButtonElement).click());
      return async () => {
        await act(async () => root.unmount());
        container.remove();
      };
    }

    it("marks each one under its name, in the words the chat's model picker uses", async () => {
      const health: FreeModelHealthMap = {
        [USUAL]: held("daily_limit", 100 * 60_000),
        [BUSY]: held("busy", 90_000),
        [OFFLINE]: held("withdrawn", 5 * 60_000),
        [ANSWERS]: { state: "ok", until: null, checkedAt: iso(-60_000), last: "ok" },
      };
      freeModels.health.mockResolvedValue(health);
      const close = await open();
      try {
        await settle(() => expect(mark(USUAL)).not.toBeNull());
        // At its daily limit, and when it is back.
        expect(mark(USUAL)!.dataset.state).toBe("daily_limit");
        expect(mark(USUAL)!.textContent).toBe(freeHealthNote(health[USUAL]));
        expect(mark(USUAL)!.textContent).toContain("1 h 40 min");
        // Busy at its provider, closed by its provider.
        expect(mark(BUSY)!.dataset.state).toBe("busy");
        expect(mark(BUSY)!.textContent).toBe(freeHealthNote(health[BUSY]));
        expect(mark(OFFLINE)!.dataset.state).toBe("withdrawn");
        expect(mark(OFFLINE)!.textContent).toBe(freeHealthNote(health[OFFLINE]));
        // Nothing on one that answers, or one nobody asked yet.
        expect(row(ANSWERS)).not.toBeNull();
        expect(mark(ANSWERS)).toBeNull();
        expect(row(NEVER_ASKED)).not.toBeNull();
        expect(mark(NEVER_ASKED)).toBeNull();
        // A model that runs on another one answers when that one does.
        expect(resolveFreeModel(MOAN_MODEL_ID).puterModel).toBe(USUAL);
        expect(mark(MOAN_MODEL_ID)!.textContent).toBe(mark(USUAL)!.textContent);

        // The mark is its own line under the model's id, whole: a phone has no room beside the name.
        expect(mark(BUSY)!.previousElementSibling!.textContent).toBe(BUSY);
        expect(mark(BUSY)!.className).not.toContain("truncate");
      } finally {
        await close();
      }
    });

    it("marks nothing while every free model answers", async () => {
      const close = await open();
      try {
        await settle(() => expect(freeModels.health).toHaveBeenCalled());
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(row(USUAL)).not.toBeNull();
        expect(document.body.querySelector('[data-slot="model-health"]')).toBeNull();
      } finally {
        await close();
      }
    });

    it("does not ask about the free models for a provider with its own key", async () => {
      freeModels.health.mockResolvedValue({ [USUAL]: held("busy", 90_000) });
      const close = await open({ provider: "openai", model: "gpt-5.5" });
      try {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(row("gpt-5.5")).not.toBeNull();
        expect(freeModels.health).not.toHaveBeenCalled();
        expect(document.body.querySelector('[data-slot="model-health"]')).toBeNull();
      } finally {
        await close();
      }
    });
  });
});
