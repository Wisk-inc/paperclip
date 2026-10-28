// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_AI_PROVIDER_INFO, type StudioAiKeyStatus } from "@paperclipai/shared";
import { ToastProvider } from "@/context/ToastContext";
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
});
