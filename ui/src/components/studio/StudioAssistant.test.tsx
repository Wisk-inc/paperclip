// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_AI_PROVIDER_INFO, type FreeModelHealthEntry, type FreeModelHealthMap, type StudioAiKeyStatus, type StudioAssistantTurn } from "@paperclipai/shared";
import type { ModelCatalogSnapshot } from "@paperclipai/shared/model-catalog";
import { ToastProvider } from "@/context/ToastContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { modelDisplayName } from "@/lib/model-brand";
import { queryKeys } from "@/lib/queryKeys";
import { StudioAssistant } from "./StudioAssistant";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

// Which free models answer; every one of them unless a test says otherwise.
const freeModels = vi.hoisted(() => ({ health: vi.fn(async (): Promise<FreeModelHealthMap> => ({})) }));
vi.mock("@/api/free-models", () => ({ freeModelsApi: freeModels }));
// The model menu reads the catalog the server keeps; empty here.
vi.mock("@/api/modelCatalog", () => ({ modelCatalogApi: { get: vi.fn(async (): Promise<ModelCatalogSnapshot> => ({ source: "built-in", fetchedAt: null, models: [] })) } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = "automa.studio.ai.company-1";
const FREE_MODEL = STUDIO_AI_PROVIDER_INFO.free.defaultModel;

function status(provider: StudioAiKeyStatus["provider"], connected: boolean, source: StudioAiKeyStatus["source"] = connected ? "studio" : null): StudioAiKeyStatus {
  return { provider, connected, last4: connected && provider !== "free" ? "abcd" : null, baseUrl: null, updatedAt: null, source };
}

/** What the server lists: every provider, the free models always connected. */
const FREE_ONLY: StudioAiKeyStatus[] = [status("free", true, "automa"), status("openai", false), status("anthropic", false), status("custom", false)];

describe("StudioAssistant", () => {
  let container: HTMLDivElement;
  let root: Root;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  beforeEach(() => {
    window.localStorage.clear();
    client.clear();
    freeModels.health.mockReset();
    freeModels.health.mockResolvedValue({});
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const draw = (props: Partial<Parameters<typeof StudioAssistant>[0]> = {}) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <ToastProvider>
              <StudioAssistant
                turns={[]}
                running={false}
                keys={FREE_ONLY}
                onSaveKey={vi.fn(async () => undefined)}
                onRemoveKey={vi.fn(async () => undefined)}
                onSend={vi.fn(async () => undefined)}
                onStop={vi.fn(async () => undefined)}
                onClear={vi.fn(async () => undefined)}
                storageKey={STORAGE_KEY}
                {...props}
              />
            </ToastProvider>
          </ThemeProvider>
        </QueryClientProvider>,
      ),
    );

  const type = (text: string) =>
    act(async () => {
      const box = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the assistant"]')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);

  it("never asks for a key on the free models, also before the key list arrives", async () => {
    await draw({ keys: [] });
    expect(container.querySelector('[data-testid="studio-ai-key-form"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the assistant"]')!.disabled).toBe(false);

    // Loaded, the free models' status reads "automa"; that is not an organization key to swap out.
    await draw({ keys: FREE_ONLY });
    expect(container.querySelector('[data-testid="studio-ai-key-form"]')).toBeNull();
    expect(container.textContent).not.toContain("organization");
    expect(button("Use another")).toBeUndefined();
  });

  it("drops a saved teammate whose key is gone, so messages on the free models still go through", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider: "free", model: FREE_MODEL, team: [{ provider: "openai", model: "gpt-5.5" }, { provider: "free", model: "nvidia/nemotron-3.5-lightning:free" }] }));
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    await draw({ onSend });
    expect(container.querySelector('[data-testid="studio-team-left"]')?.textContent).toContain("No OpenAI key");
    await type("Build a to-do app");
    await act(async () => button("Send")!.click());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![5]).toEqual([{ provider: "free", model: "nvidia/nemotron-3.5-lightning:free" }]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).team).toEqual([{ provider: "free", model: "nvidia/nemotron-3.5-lightning:free" }]);
  });

  it("keeps a teammate whose key is there", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider: "free", model: FREE_MODEL, team: [{ provider: "openai", model: "gpt-5.5" }] }));
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    await draw({ onSend, keys: [status("free", true, "automa"), status("openai", true)] });
    expect(container.querySelector('[data-testid="studio-team-left"]')).toBeNull();
    await type("Review the code");
    await act(async () => button("Send")!.click());
    expect(onSend.mock.calls[0]![5]).toEqual([{ provider: "openai", model: "gpt-5.5" }]);
  });

  it("says why Stop and New chat failed instead of doing nothing", async () => {
    await draw({ running: true, onStop: vi.fn(async () => Promise.reject(new Error("The server is restarting"))) });
    await act(async () => button("Stop")!.click());
    expect(container.textContent).toContain("Couldn't stop the assistant: The server is restarting");

    const turns = [{ id: "t1", role: "user" as const, text: "Hi", steps: [], provider: null, model: null, error: null, createdAt: new Date().toISOString() }];
    await draw({ turns, running: false, onClear: vi.fn(async () => Promise.reject(new Error("Offline"))) });
    await act(async () => button("New chat")!.click());
    expect(container.textContent).toContain("Couldn't start a new chat: Offline");
  });

  it("asks for a model instead of ignoring Send when none is picked", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider: "custom", model: "" }));
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    await draw({ onSend, keys: [...FREE_ONLY.filter((key) => key.provider !== "custom"), status("custom", true)] });
    await type("Hello");
    await act(async () => button("Send")!.click());
    expect(onSend).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Pick a model first");
  });

  const at = "2026-10-30T00:00:00.000Z";
  const BACKEND = "google/gemma-4-31b-it:free";
  const FRONTEND = "qwen/qwen3.8-27b:free";
  function teamReply(): StudioAssistantTurn[] {
    return [
      { id: "u1", role: "user", text: "Build a to-do app", steps: [], provider: "free", model: FREE_MODEL, error: null, createdAt: at },
      {
        id: "a1",
        role: "assistant",
        text: "Your to-do app is ready.",
        provider: "free",
        model: FREE_MODEL,
        error: null,
        createdAt: at,
        steps: [
          { tool: "run_team", summary: "Team of 2 finished: 2 done", ok: true, detail: null },
          { tool: "start_app", summary: "Started the app", ok: true, detail: null },
          { tool: "say", summary: "Your to-do app is ready.", ok: true, detail: null },
        ],
        usage: { inputTokens: 3200, outputTokens: 800, costUsd: 0 },
        leadUsage: { inputTokens: 1000, outputTokens: 200, costUsd: 0 },
        agents: [
          { id: "m1", name: "Gemma", provider: "free", model: BACKEND, role: "backend: the API", task: "Write api.py", status: "done", steps: 2, report: "api.py is written.", usage: { inputTokens: 1500, outputTokens: 500, costUsd: 0 }, startedAt: at, finishedAt: at },
          { id: "m2", name: "Qwen", provider: "free", model: FRONTEND, role: "frontend: the page", task: "Write index.html", status: "done", steps: 1, report: "index.html is written.", usage: { inputTokens: 700, outputTokens: 100, costUsd: 0 }, startedAt: at, finishedAt: at },
        ],
        teamChat: [
          { id: "c1", from: "lead", fromName: "Nemotron (lead)", fromModel: FREE_MODEL, to: "m1", toName: "Gemma (backend)", kind: "task", text: "Write api.py", createdAt: at },
          { id: "c2", from: "m1", fromName: "Gemma (backend)", fromModel: BACKEND, to: "m2", toName: "Qwen (frontend)", kind: "message", text: "The API is at /api/todos", createdAt: at },
          { id: "c3", from: "m2", fromName: "Qwen (frontend)", fromModel: FRONTEND, to: "lead", toName: "Nemotron (lead)", kind: "report", text: "index.html is written.", createdAt: at },
        ],
      },
    ];
  }

  it("shows every model on the team with its logo and tokens, and what they told each other", async () => {
    await draw({ turns: teamReply() });

    const roster = container.querySelector('[data-testid="studio-team-roster"]')!;
    expect(roster.querySelectorAll("li")).toHaveLength(3);
    expect(roster.querySelectorAll('[data-slot="model-logo"]')).toHaveLength(3);
    expect(roster.textContent).toContain("Lead · 1.2k");
    expect(roster.textContent).toContain("backend · 2.0k");
    expect(roster.textContent).toContain("frontend · 800");

    const chat = container.querySelector('[data-testid="studio-team-chat"]')!;
    expect(chat.querySelectorAll(":scope > li")).toHaveLength(3);
    expect(chat.textContent).toContain("Gemma (backend)→Qwen (frontend)");
    expect(chat.textContent).toContain("The API is at /api/todos");

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="studio-team-view-work"]')!.click());
    const cards = container.querySelectorAll('[data-testid="studio-team-agent"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("2.0k tokens");

    expect(container.querySelector('[data-testid="studio-turn-usage"]')!.textContent).toBe("3.2k in · 800 out · Free");
    expect(container.querySelector('[data-testid="studio-turn-usage-by-model"]')!.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector('[data-testid="studio-session-usage"]')!.textContent).toContain("This chat: 4.0k tokens · Free");
  });

  it("folds a long team message until it is opened", async () => {
    const [user, reply] = teamReply();
    const long = `${"The API returns the list as JSON. ".repeat(12)}Done.`;
    await draw({ turns: [user!, { ...reply!, teamChat: [...reply!.teamChat!, { ...reply!.teamChat![1]!, id: "c4", text: long }] }] });
    const folded = () => container.querySelectorAll('[data-testid="studio-team-chat"] [data-collapsed="true"]').length;
    expect(folded()).toBe(1);
    await act(async () => button("Show all")!.click());
    expect(folded()).toBe(0);
    expect(button("Show less")).toBeDefined();
  });

  it("opens the page from the reply that started the app, once the preview answers", async () => {
    const onShowPreview = vi.fn();
    await draw({ turns: teamReply(), previewReady: false, onShowPreview });
    expect(container.querySelector('[data-testid="studio-open-page"]')).toBeNull();

    await draw({ turns: teamReply(), previewReady: true, onShowPreview });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="studio-open-page"]')!.click());
    expect(onShowPreview).toHaveBeenCalledTimes(1);
  });

  it("folds a long link inside the person's bubble instead of running it off the screen", async () => {
    const text = `Use this page: https://example.com/${"a-very-long-path-".repeat(12)}`;
    await draw({ turns: [{ id: "u1", role: "user", text, steps: [], provider: "free", model: FREE_MODEL, error: null, createdAt: at }] });
    const bubble = container.querySelector<HTMLElement>('[data-testid="studio-user-text"]')!;
    expect(bubble.textContent).toBe(text);
    // The bubble never grows past its row, and breaks a word that is wider than it.
    expect(bubble.classList.contains("max-w-full")).toBe(true);
    expect(bubble.classList.contains("break-words")).toBe(true);
    // The row keeps to a share of the pane, so its start stays on screen.
    const row = bubble.closest("li")!;
    expect(row.classList.contains("max-w-(--sz-85pct)")).toBe(true);
    expect(row.classList.contains("min-w-0")).toBe(true);
  });

  it("leaves the same space under Send as beside it", async () => {
    await draw();
    const composer = container.querySelector<HTMLFormElement>('[data-testid="studio-assistant-composer"]')!;
    expect(composer.classList.contains("p-2")).toBe(true);
    // No bottom padding of its own: one that is 0 would put Send on the tab bar.
    expect([...composer.classList].some((name) => name.startsWith("pb-"))).toBe(false);
  });

  // Which free models answer: the first model of a new chat, and what a failed reply offers.

  const OTHER = "google/gemma-4-26b-a4b-it:free";
  const iso = (fromNowMs: number) => new Date(Date.now() + fromNowMs).toISOString();
  const answered = (): FreeModelHealthEntry => ({ state: "ok", until: null, checkedAt: iso(-60_000), last: "ok" });
  const busy = (): FreeModelHealthEntry => ({ state: "busy", until: iso(90_000), checkedAt: iso(-5_000), last: "busy" });
  const atLimit = (): FreeModelHealthEntry => ({ state: "daily_limit", until: iso(3 * 3600_000), checkedAt: iso(-5_000), last: "daily_limit" });
  /** Every free model refusing but one, so the one to start on or to offer does not depend on the list's order. */
  const onlyAnswering = (model: string, usual: FreeModelHealthEntry = busy()): FreeModelHealthMap =>
    Object.fromEntries(STUDIO_AI_PROVIDER_INFO.free.models.map((id) => [id, id === model ? answered() : id === FREE_MODEL ? usual : busy()]));
  /** Waits for what a query's answer puts on screen; each try leaves act, so the updates it queued are drawn. */
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
  /** Lets a health answer that changes nothing land. */
  const healthRead = async () => {
    await settle(() => expect(client.getQueryState(queryKeys.freeModels.health())?.status).toBe("success"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const find = <T extends HTMLElement = HTMLButtonElement>(testId: string) => container.querySelector<T>(`[data-testid="${testId}"]`);
  const picker = () => find("studio-model-button")!.textContent ?? "";
  const pickInMenu = async (model: string) => {
    await act(async () => find("studio-model-button")!.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>(`[data-model-id="${model}"]`)!.click());
  };
  const kept = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as { provider: string; model: string } | null;

  function failedReply(overrides: Partial<StudioAssistantTurn> = {}, asked: Partial<StudioAssistantTurn> = {}): StudioAssistantTurn[] {
    return [
      { id: "u1", role: "user", text: "Build a to-do app", steps: [], provider: "free", model: FREE_MODEL, error: null, createdAt: at, ...asked },
      { id: "a1", role: "assistant", text: "", steps: [], provider: "free", model: FREE_MODEL, error: "The model is busy at its provider right now.", createdAt: at, ...overrides },
    ];
  }

  it("starts a new chat on a free model that answers when the usual one does not, and says so", async () => {
    freeModels.health.mockResolvedValue(onlyAnswering(OTHER, atLimit()));
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    await draw({ onSend });
    await settle(() => expect(find("studio-first-model-note")).not.toBeNull());
    expect(find("studio-first-model-note")!.textContent).toBe(
      `${modelDisplayName(FREE_MODEL)} has reached its daily free limit, so this chat starts on ${modelDisplayName(OTHER)}. You can change it in the model menu.`,
    );
    expect(picker()).toContain(modelDisplayName(OTHER));
    // Nobody chose it yet, so it is not kept: the next new chat looks again.
    expect(kept()).toBeNull();

    // The model shown is the one that is asked, and the conversation stays with it.
    await type("Build a to-do app");
    await act(async () => button("Send")!.click());
    expect(onSend.mock.calls[0]!.slice(0, 3)).toEqual(["Build a to-do app", "free", OTHER]);
    expect(kept()).toMatchObject({ provider: "free", model: OTHER });
  });

  it("drops the first-model line once the person picks a model, and keeps what they picked", async () => {
    freeModels.health.mockResolvedValue(onlyAnswering(OTHER));
    await draw();
    await settle(() => expect(find("studio-first-model-note")).not.toBeNull());
    expect(find("studio-first-model-note")!.textContent).toContain("is busy at its provider right now");

    await pickInMenu(FREE_MODEL);
    expect(find("studio-first-model-note")).toBeNull();
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));
    expect(kept()).toMatchObject({ provider: "free", model: FREE_MODEL });
  });

  it("starts on the usual model when it answers, and keeps nothing until the person chooses", async () => {
    freeModels.health.mockResolvedValue({ [FREE_MODEL]: answered(), [OTHER]: answered() });
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    await draw({ onSend });
    await healthRead();
    expect(find("studio-first-model-note")).toBeNull();
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));
    expect(kept()).toBeNull();

    // A message on the usual model nobody chose keeps nothing either, so the next new chat still looks.
    await type("Hello");
    await act(async () => button("Send")!.click());
    expect(onSend.mock.calls[0]!.slice(1, 3)).toEqual(["free", FREE_MODEL]);
    expect(kept()).toBeNull();

    // A thinking level is a choice: it is kept, with the model shown.
    await act(async () => button("Deep")!.click());
    expect(kept()).toMatchObject({ provider: "free", model: FREE_MODEL, thinking: "high" });
  });

  it("looks once per new chat: not again while it is open, and again after New chat", async () => {
    freeModels.health.mockResolvedValue({ [FREE_MODEL]: answered(), [OTHER]: answered() });
    await draw();
    await healthRead();
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));

    // The usual model stops answering while the person is in the new chat: nothing moves under them.
    await act(async () => {
      client.setQueryData(queryKeys.freeModels.health(), onlyAnswering(OTHER));
      // The query tells its readers on the next tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.getQueryData<FreeModelHealthMap>(queryKeys.freeModels.health())![FREE_MODEL]!.state).toBe("busy");
    expect(find("studio-first-model-note")).toBeNull();
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));

    // Nor once the conversation has turns.
    const [user, reply] = teamReply();
    await draw({ turns: [user!, reply!] });
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));

    // New chat, with nothing kept: a brand-new one starts on a model that answers, and says so.
    await draw({ turns: [] });
    await settle(() => expect(find("studio-first-model-note")).not.toBeNull());
    expect(picker()).toContain(modelDisplayName(OTHER));
  });

  it.each([
    ["another model", { provider: "free", model: FRONTEND }],
    ["the usual model with a thinking level", { provider: "free", model: FREE_MODEL, thinking: "high" }],
    ["the usual model with a team", { provider: "free", model: FREE_MODEL, team: [{ provider: "free", model: BACKEND }] }],
  ])("never changes a kept choice that is the person's (%s), also when its model is not answering", async (_what, stored) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    freeModels.health.mockResolvedValue(onlyAnswering(OTHER));
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    await draw({ onSend });
    await healthRead();
    expect(find("studio-first-model-note")).toBeNull();
    expect(picker()).toContain(modelDisplayName(stored.model));
    await type("Hello");
    await act(async () => button("Send")!.click());
    expect(onSend.mock.calls[0]!.slice(1, 3)).toEqual(["free", stored.model]);
    expect(kept()).toEqual(stored);
  });

  it("counts a kept usual model with nothing else set as not chosen: older versions kept it on their own", async () => {
    const untouched = { provider: "free", model: FREE_MODEL };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(untouched));
    freeModels.health.mockResolvedValue(onlyAnswering(OTHER));
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    await draw({ onSend });
    await settle(() => expect(find("studio-first-model-note")).not.toBeNull());
    expect(find("studio-first-model-note")!.textContent).toBe(
      `${modelDisplayName(FREE_MODEL)} is busy at its provider right now, so this chat starts on ${modelDisplayName(OTHER)}. You can change it in the model menu.`,
    );
    expect(picker()).toContain(modelDisplayName(OTHER));
    expect(kept()).toEqual(untouched);

    await type("Hello");
    await act(async () => button("Send")!.click());
    expect(onSend.mock.calls[0]!.slice(1, 3)).toEqual(["free", OTHER]);
    expect(kept()).toMatchObject({ provider: "free", model: OTHER });
  });

  it("leaves a kept usual model alone when it answers, when the chat has turns, and once the person picked it here", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider: "free", model: FREE_MODEL }));
    freeModels.health.mockResolvedValue({ [FREE_MODEL]: answered(), [OTHER]: answered() });
    const [user, reply] = teamReply();
    await draw({ turns: [user!, reply!] });
    await healthRead();
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));

    // Picked in this session: it stays, also in a new chat when it stops answering.
    await pickInMenu(FREE_MODEL);
    await act(async () => {
      client.setQueryData(queryKeys.freeModels.health(), onlyAnswering(OTHER));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await draw({ turns: [] });
    await healthRead();
    expect(find("studio-first-model-note")).toBeNull();
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));
  });

  it("does not look at the first model while the conversation is still on its way", async () => {
    freeModels.health.mockResolvedValue(onlyAnswering(OTHER));
    await draw({ turnsLoaded: false });
    await healthRead();
    expect(find("studio-first-model-note")).toBeNull();
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));

    // It arrives with turns: the line never shows above it, and its model stays.
    const [user, reply] = teamReply();
    await draw({ turnsLoaded: true, turns: [user!, reply!] });
    await healthRead();
    expect(find("studio-first-model-note")).toBeNull();
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));
  });

  it("looks at the first model once an empty conversation has arrived", async () => {
    freeModels.health.mockResolvedValue(onlyAnswering(OTHER));
    await draw({ turnsLoaded: false });
    await healthRead();
    expect(find("studio-first-model-note")).toBeNull();

    await draw({ turnsLoaded: true });
    await settle(() => expect(find("studio-first-model-note")).not.toBeNull());
    expect(picker()).toContain(modelDisplayName(OTHER));
  });

  it("never changes a model the person picked before the findings arrived", async () => {
    let arrive!: (health: FreeModelHealthMap) => void;
    freeModels.health.mockReturnValue(new Promise<FreeModelHealthMap>((resolve) => { arrive = resolve; }));
    await draw();
    await pickInMenu(FREE_MODEL);
    await act(async () => arrive(onlyAnswering(OTHER)));
    await healthRead();
    expect(find("studio-first-model-note")).toBeNull();
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));
  });

  it("never changes the model of a conversation that has turns", async () => {
    freeModels.health.mockResolvedValue(onlyAnswering(OTHER));
    const [user, reply] = teamReply();
    await draw({ turns: [user!, reply!] });
    await healthRead();
    expect(find("studio-first-model-note")).toBeNull();
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));
  });

  it("asks again which free models answer when a reply ends in an error", async () => {
    const [user, failed] = failedReply();
    await draw({ turns: [user!, { ...failed!, error: null }], running: true });
    await healthRead();
    expect(freeModels.health).toHaveBeenCalledTimes(1);

    await draw({ turns: [user!, failed!], running: false });
    await settle(() => expect(freeModels.health).toHaveBeenCalledTimes(2));
  });

  it("shows a failed reply as a notice with Try again, which sends the last message again", async () => {
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    await draw({ turns: failedReply(), onSend });
    await healthRead();
    expect(find<HTMLElement>("studio-turn-error")!.textContent).toBe("The model is busy at its provider right now.");

    await act(async () => find("studio-retry")!.click());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]!.slice(0, 4)).toEqual(["Build a to-do app", "free", FREE_MODEL, []]);
    // What was typed in the meantime stays in the box.
    expect(container.textContent).not.toContain("can't be sent again");
  });

  it("offers a free model that answers; one tap picks it and sends the same message with it", async () => {
    freeModels.health.mockResolvedValue({ [FREE_MODEL]: busy(), [OTHER]: answered() });
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    await draw({ turns: failedReply(), onSend });
    await settle(() => expect(find("studio-switch-model")?.textContent).toBe(`Ask ${modelDisplayName(OTHER)} instead`));
    // Offering changes nothing: the picker still shows the model that was asked.
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => find("studio-switch-model")!.click());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]!.slice(0, 4)).toEqual(["Build a to-do app", "free", OTHER, []]);
    expect(picker()).toContain(modelDisplayName(OTHER));
    expect(kept()).toMatchObject({ provider: "free", model: OTHER });

    // It counts as picked: the next message goes to it too.
    await type("Add a dark mode");
    await act(async () => button("Send")!.click());
    expect(onSend.mock.calls[1]!.slice(0, 3)).toEqual(["Add a dark mode", "free", OTHER]);
  });

  it("offers no other model after a reply on a key of the person's own, or one they stopped", async () => {
    freeModels.health.mockResolvedValue({ [FREE_MODEL]: busy(), [OTHER]: answered() });
    await draw({ turns: failedReply({ provider: "openai", model: "gpt-5.5", error: "OpenAI error 500" }, { provider: "openai", model: "gpt-5.5" }) });
    await healthRead();
    expect(find("studio-retry")).not.toBeNull();
    expect(find("studio-switch-model")).toBeNull();

    await draw({ turns: failedReply({ error: "Stopped." }) });
    expect(find<HTMLElement>("studio-turn-error")!.textContent).toBe("Stopped.");
    expect(find("studio-retry")).not.toBeNull();
    expect(find("studio-switch-model")).toBeNull();
  });

  it("puts the text back and asks for the files again when the failed message had attachments", async () => {
    freeModels.health.mockResolvedValue({ [FREE_MODEL]: busy(), [OTHER]: answered() });
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    const box = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the assistant"]')!;
    await draw({ turns: failedReply({}, { text: "Make it look like this", attachments: [{ name: "sketch.png", type: "image/png", size: 2048 }] }), onSend });
    await settle(() => expect(find("studio-switch-model")).not.toBeNull());

    await act(async () => find("studio-retry")!.click());
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe("Make it look like this");
    expect(container.textContent).toContain("The file sent with that message can't be sent again from here. Attach it again, then tap Send.");
    expect(picker()).toContain(modelDisplayName(FREE_MODEL));

    // The other model is still picked on its tap; the files still have to be attached again.
    await type("");
    await act(async () => find("studio-switch-model")!.click());
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe("Make it look like this");
    expect(picker()).toContain(modelDisplayName(OTHER));
    expect(kept()).toMatchObject({ provider: "free", model: OTHER });
  });

  it("offers nothing while a reply is running", async () => {
    freeModels.health.mockResolvedValue({ [FREE_MODEL]: busy(), [OTHER]: answered() });
    await draw({ turns: failedReply(), running: true });
    await act(async () => { await Promise.resolve(); });
    expect(find<HTMLElement>("studio-turn-error")).not.toBeNull();
    expect(find("studio-retry")).toBeNull();
    expect(find("studio-switch-model")).toBeNull();

    await draw({ turns: failedReply(), running: false });
    await settle(() => expect(find("studio-switch-model")).not.toBeNull());
    expect(find("studio-retry")).not.toBeNull();
  });

  it("offers Try again and another model only on the newest failed reply", async () => {
    freeModels.health.mockResolvedValue({ [FREE_MODEL]: busy(), [OTHER]: answered() });
    const onSend = vi.fn(async (..._args: unknown[]) => undefined);
    const [user, failed] = failedReply();
    const again: StudioAssistantTurn[] = [user!, failed!, { ...user!, id: "u2", text: "Add a dark mode" }, { ...failed!, id: "a2" }];
    await draw({ turns: again, onSend });
    await settle(() => expect(find("studio-switch-model")).not.toBeNull());
    expect(container.querySelectorAll('[data-testid="studio-turn-error"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="studio-retry"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="studio-switch-model"]')).toHaveLength(1);
    const replies = container.querySelectorAll('[data-testid="studio-assistant-log"] ol > li');
    expect(replies[replies.length - 1]!.querySelector('[data-testid="studio-retry"]')).not.toBeNull();
    await act(async () => find("studio-retry")!.click());
    expect(onSend.mock.calls[0]![0]).toBe("Add a dark mode");

    // An older failure keeps its notice, without buttons, once a later reply came.
    await draw({ turns: [user!, failed!, { ...user!, id: "u2", text: "Add a dark mode" }, { ...failed!, id: "a2", error: null, text: "Done." }], onSend });
    expect(container.querySelectorAll('[data-testid="studio-turn-error"]')).toHaveLength(1);
    expect(find("studio-retry")).toBeNull();
    expect(find("studio-switch-model")).toBeNull();
  });
});
