// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_AI_PROVIDER_INFO, type StudioAiKeyStatus, type StudioAssistantTurn } from "@paperclipai/shared";
import { ToastProvider } from "@/context/ToastContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { StudioAssistant } from "./StudioAssistant";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

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
});
