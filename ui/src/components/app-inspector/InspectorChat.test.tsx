// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FreeModelHealthMap } from "@paperclipai/shared";
import type { InspectorChatMessage, InspectorChatQuestion, InspectorChatView } from "@/api/app-inspector";
import { ApiError } from "@/api/client";
import { UNDO_WINDOW_MS } from "@/hooks/useUndoableAction";
import { __resetInspectorChat, InspectorChat } from "./InspectorChat";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { reply: InspectorChatMessage; messages: InspectorChatMessage[] };
const api = vi.hoisted(() => ({
  chat: vi.fn(),
  askChat: vi.fn(),
  clearChat: vi.fn(),
  health: vi.fn(),
  pushToast: vi.fn(),
}));
vi.mock("@/api/app-inspector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/app-inspector")>()),
  appInspectorApi: { chat: api.chat, askChat: api.askChat, clearChat: api.clearChat },
}));
vi.mock("@/api/free-models", () => ({ freeModelsApi: { health: api.health } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: api.pushToast }) }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div data-testid="markdown">{children}</div>,
}));

const COMPANY = "company-1";
const PROJECT = "project-1";
const BUSY = "nvidia/nemotron-3-ultra-550b-a55b:free";
const LIGHTNING = "nvidia/nemotron-3.5-lightning:free";
const GEMMA = "google/gemma-4-26b-a4b-it:free";
const MODELS = [BUSY, LIGHTNING, GEMMA];
const STORAGE_KEY = "automa.inspector.chat.model";
const JAVA_FILE = { path: "com/example/notes/MainActivity.java", view: "java" as const };

const at = (second: number) => new Date(Date.UTC(2026, 10, 22, 12, 0, second)).toISOString();
const SAVED: InspectorChatMessage[] = [
  { id: "m1", role: "user", text: "What does this app do?", at: at(1), path: null },
  { id: "m2", role: "assistant", text: "It keeps notes.", at: at(2), model: GEMMA },
  { id: "m3", role: "user", text: "Where is the network call?", at: at(3), path: "smali/com/example/notes/SyncService.smali", view: "files" },
  { id: "m4", role: "assistant", text: "In SyncService.upload().", at: at(4), model: "claude" },
];

function view(overrides: Partial<InspectorChatView> = {}): InspectorChatView {
  return { messages: [], models: MODELS, defaultModel: BUSY, claude: false, ...overrides };
}

/** What the server sends back for a question: the conversation with the question and its answer added. */
function answered(before: InspectorChatMessage[], input: InspectorChatQuestion, text: string): Reply {
  const question: InspectorChatMessage = { id: `q${before.length}`, role: "user", text: input.message, at: at(10), path: input.path ?? null, ...(input.path ? { view: input.view } : {}) };
  const reply: InspectorChatMessage = { id: `a${before.length}`, role: "assistant", text, at: at(11), model: input.model };
  return { reply, messages: [...before, question, reply] };
}

const busyError = () =>
  new ApiError("Nemotron 3 Ultra is busy right now. Ask again in a minute, or pick another model.", 503, { error: "busy", model: BUSY });

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  window.localStorage.clear();
  __resetInspectorChat();
  for (const mock of Object.values(api)) mock.mockReset();
  api.chat.mockResolvedValue(view());
  api.health.mockResolvedValue({});
  api.clearChat.mockResolvedValue({ ok: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

/** Lets queries and the promises behind them settle. */
const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function draw(props: Partial<Parameters<typeof InspectorChat>[0]> = {}) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InspectorChat companyId={COMPANY} projectId={PROJECT} appName="Notes" onClose={vi.fn()} {...props} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.body.querySelector<T>(`[data-testid="${id}"]`);
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const type = (text: string) =>
  act(async () => {
    const box = byId<HTMLTextAreaElement>("inspector-chat-input")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
const input = () => byId<HTMLTextAreaElement>("inspector-chat-input")!;
const shownModel = () => byId("inspector-chat-model")!.getAttribute("data-model");
const pick = async (model: string) => {
  await click(byId("inspector-chat-model"));
  await click(document.body.querySelector(`[data-testid="inspector-chat-models"] [data-model-id="${model}"]`));
};
/** The question sent with the nth request. */
const asked = (call = 0) => api.askChat.mock.calls[call]![2] as InspectorChatQuestion;

describe("InspectorChat", () => {
  it("shows the saved conversation: each answer under its model's name, a file question with its file", async () => {
    api.chat.mockResolvedValue(view({ messages: SAVED }));
    await draw();

    expect(api.chat).toHaveBeenCalledWith(COMPANY, PROJECT);
    expect(byId("inspector-chat")!.getAttribute("role")).toBe("dialog");
    expect(byId("inspector-chat")!.textContent).toContain("Notes");
    const log = byId("inspector-chat-log")!;
    expect([...log.querySelectorAll("[data-role]")].map((item) => item.getAttribute("data-role"))).toEqual(["user", "assistant", "user", "assistant"]);
    expect(log.textContent).toContain("What does this app do?");
    expect(log.textContent).toContain("It keeps notes.");
    const answers = [...log.querySelectorAll('[data-role="assistant"]')];
    expect(answers[0]!.textContent).toContain("Gemma 4");
    expect(answers[1]!.textContent).toContain("Claude");
    // Only the question asked about a file carries a file chip, by the file's name.
    const chips = [...log.querySelectorAll('[data-testid="inspector-chat-file"]')];
    expect(chips.map((chip) => chip.textContent)).toEqual(["SyncService.smali"]);
    expect(byId("inspector-chat-empty")).toBeNull();
  });

  it("offers suggestions that fill the box: about the file when one is open, else about the app", async () => {
    await draw({ file: JAVA_FILE });
    expect(byId("inspector-chat-empty")!.textContent).toContain("Ask about MainActivity.java");
    const forFile = [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="inspector-chat-suggestion"]')];
    expect(forFile.map((item) => item.textContent)).toEqual(["Explain what this file does", "What should I look at in this file?", "How would I change what this does?"]);
    await click(forFile[0]);
    expect(input().value).toBe("Explain what this file does");
    expect(api.askChat).not.toHaveBeenCalled();

    await click(byId("inspector-chat-about-remove"));
    const forApp = [...document.body.querySelectorAll('[data-testid="inspector-chat-suggestion"]')];
    expect(forApp.map((item) => item.textContent)).toEqual(["What does this app do?", "Where does it talk to the network?", "Which files should I read first?"]);
  });

  it("asks about the open file with its path, its view and the model shown, and shows the reply", async () => {
    api.chat.mockResolvedValue(view({ defaultModel: GEMMA }));
    api.askChat.mockImplementation(async (_company: string, _project: string, question: InspectorChatQuestion) => answered([], question, "It starts the app and loads the notes."));
    await draw({ file: JAVA_FILE });

    expect(byId("inspector-chat-about")!.textContent).toContain("About MainActivity.java");
    expect(shownModel()).toBe(GEMMA);
    expect(byId<HTMLButtonElement>("inspector-chat-send")!.disabled).toBe(true);
    await type("What does this file do?");
    await click(byId("inspector-chat-send"));

    expect(api.askChat).toHaveBeenCalledTimes(1);
    expect(api.askChat.mock.calls[0]!.slice(0, 2)).toEqual([COMPANY, PROJECT]);
    expect(asked()).toEqual({ message: "What does this file do?", path: JAVA_FILE.path, view: "java", model: GEMMA });
    const log = byId("inspector-chat-log")!;
    expect(log.textContent).toContain("What does this file do?");
    expect(log.textContent).toContain("It starts the app and loads the notes.");
    expect(log.querySelector('[data-testid="inspector-chat-file"]')!.textContent).toBe("MainActivity.java");
    expect(input().value).toBe("");
    expect(byId("inspector-chat-notice")).toBeNull();
  });

  it("sends with Ctrl+Enter, and Enter alone only adds a line", async () => {
    api.askChat.mockImplementation(async (_company: string, _project: string, question: InspectorChatQuestion) => answered([], question, "Yes."));
    await draw();
    await type("Is it debuggable?");
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(api.askChat).not.toHaveBeenCalled();
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    await settle();
    expect(asked().message).toBe("Is it debuggable?");
  });

  it("starts on the model picked the last time when it is still offered, else on the server's default; a pick is stored", async () => {
    window.localStorage.setItem(STORAGE_KEY, GEMMA);
    await draw();
    expect(shownModel()).toBe(GEMMA);
    expect(byId("inspector-chat-model")!.textContent).toContain("Gemma 4");

    await pick(LIGHTNING);
    expect(shownModel()).toBe(LIGHTNING);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(LIGHTNING);
    expect(document.body.querySelector('[data-testid="inspector-chat-models"]')).toBeNull();

    // A stored model the server no longer offers gives way to the default, without being overwritten until a pick.
    await act(async () => root.unmount());
    window.localStorage.setItem(STORAGE_KEY, "gone/model:free");
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(host);
    await draw();
    expect(shownModel()).toBe(BUSY);
  });

  it('offers "Claude (your key)" only when an Anthropic key is saved', async () => {
    await draw();
    await click(byId("inspector-chat-model"));
    const sheet = () => document.body.querySelector('[data-testid="inspector-chat-models"]')!;
    expect([...sheet().querySelectorAll("[data-model-id]")].map((item) => item.getAttribute("data-model-id"))).toEqual(MODELS);
    expect(sheet().textContent).not.toContain("Claude (your key)");

    await act(async () => root.unmount());
    api.chat.mockResolvedValue(view({ claude: true }));
    // "claude" stored from an earlier session counts as offered only now.
    window.localStorage.setItem(STORAGE_KEY, "claude");
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(host);
    await draw();
    expect(shownModel()).toBe("claude");
    expect(byId("inspector-chat-model")!.textContent).toContain("Claude (your key)");
    await click(byId("inspector-chat-model"));
    expect([...sheet().querySelectorAll("[data-model-id]")].map((item) => item.getAttribute("data-model-id"))).toEqual([...MODELS, "claude"]);
    expect(sheet().querySelector('[data-model-id="claude"]')!.textContent).toContain("Claude (your key)");
  });

  it("503: keeps the question, says why in a notice, and 'Ask <model> instead' switches the menu and asks that model", async () => {
    // Lightning comes first in the list but was never asked; Gemma answered when it was last asked.
    const health: FreeModelHealthMap = {
      [BUSY]: { state: "busy", until: new Date(Date.now() + 60_000).toISOString(), checkedAt: new Date().toISOString(), last: "busy" },
      [GEMMA]: { state: "ok", until: null, checkedAt: new Date().toISOString(), last: "ok" },
    };
    api.health.mockResolvedValue(health);
    api.askChat.mockImplementation(async (_company: string, _project: string, question: InspectorChatQuestion) => {
      if (question.model === BUSY) throw busyError();
      return answered([], question, "onCreate shows the list.");
    });
    await draw({ file: JAVA_FILE });
    const healthReads = api.health.mock.calls.length;
    await type("What does onCreate do?");
    await click(byId("inspector-chat-send"));

    // Nothing was saved, so the question stays on screen, marked as not sent.
    const log = byId("inspector-chat-log")!;
    expect(log.textContent).toContain("What does onCreate do?");
    expect(log.textContent).toContain("Not sent");
    const notice = byId("inspector-chat-notice")!;
    expect(notice.textContent).toContain("Nemotron 3 Ultra is busy right now. Ask again in a minute, or pick another model.");
    expect(api.pushToast).not.toHaveBeenCalled();
    // The models' states were read again, and the offer is the one that answered, never the one that failed.
    expect(api.health.mock.calls.length).toBeGreaterThan(healthReads);
    const offer = byId("inspector-chat-switch-model")!;
    expect(offer.getAttribute("data-model")).toBe(GEMMA);
    expect(offer.textContent).toContain("Ask Gemma 4");
    expect(offer.textContent).toContain("instead");
    // Until the tap, the model shown is still the one that was asked.
    expect(shownModel()).toBe(BUSY);
    expect(api.askChat).toHaveBeenCalledTimes(1);

    await click(offer);
    expect(shownModel()).toBe(GEMMA);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(GEMMA);
    expect(api.askChat).toHaveBeenCalledTimes(2);
    expect(asked(1)).toEqual({ message: "What does onCreate do?", path: JAVA_FILE.path, view: "java", model: GEMMA });
    expect(byId("inspector-chat-notice")).toBeNull();
    expect(log.textContent).toContain("onCreate shows the list.");
    expect(log.textContent).not.toContain("Not sent");
  });

  it("Try again asks the same model with the same question", async () => {
    api.askChat.mockRejectedValueOnce(busyError());
    api.askChat.mockImplementation(async (_company: string, _project: string, question: InspectorChatQuestion) => answered([], question, "It syncs notes."));
    await draw();
    await type("What does this app do?");
    await click(byId("inspector-chat-send"));
    expect(byId("inspector-chat-notice")).not.toBeNull();

    await click(byId("inspector-chat-retry"));
    expect(api.askChat).toHaveBeenCalledTimes(2);
    expect(asked(1)).toEqual({ message: "What does this app do?", model: BUSY });
    expect(shownModel()).toBe(BUSY);
    expect(byId("inspector-chat-notice")).toBeNull();
    expect(byId("inspector-chat-log")!.textContent).toContain("It syncs notes.");
  });

  it("offers no other model when none is known to answer, and Edit puts the question back in the box", async () => {
    const held = (id: string): FreeModelHealthMap => ({ [id]: { state: "busy", until: new Date(Date.now() + 60_000).toISOString(), checkedAt: new Date().toISOString(), last: "busy" } });
    api.health.mockResolvedValue({ ...held(BUSY), ...held(LIGHTNING), ...held(GEMMA) });
    api.askChat.mockRejectedValue(busyError());
    await draw({ file: JAVA_FILE });
    await type("Explain it");
    await click(byId("inspector-chat-send"));
    expect(byId("inspector-chat-retry")).not.toBeNull();
    expect(byId("inspector-chat-switch-model")).toBeNull();

    await click(byId("inspector-chat-edit"));
    expect(input().value).toBe("Explain it");
    expect(byId("inspector-chat-notice")).toBeNull();
    expect(byId("inspector-chat-about")).not.toBeNull();
  });

  it("other failures (a reply still being written, a refused model, no connection) show their reason with Try again only", async () => {
    const failures = [
      new ApiError("A reply is still being written here. Wait for it, then ask again.", 409, { error: "busy" }),
      new ApiError("Add an Anthropic API key on the API keys page to ask Claude here, or pick a free model.", 422, { error: "no key" }),
      new ApiError("Can't reach Automa right now.", 0, null),
    ];
    api.askChat.mockRejectedValueOnce(failures[0]).mockRejectedValueOnce(failures[1]).mockRejectedValueOnce(failures[2]);
    await draw();
    const healthReads = api.health.mock.calls.length;
    await type("Hello");
    await click(byId("inspector-chat-send"));
    for (const [index, failure] of failures.entries()) {
      if (index > 0) await click(byId("inspector-chat-retry"));
      expect(api.askChat).toHaveBeenCalledTimes(index + 1);
      expect(byId("inspector-chat-notice")!.textContent).toContain(failure.message);
      expect(byId("inspector-chat-log")!.textContent).toContain("Hello");
      expect(byId("inspector-chat-retry")).not.toBeNull();
      expect(byId("inspector-chat-switch-model")).toBeNull();
    }
    // Only a model that could not answer makes the chat look for another one.
    expect(api.health.mock.calls.length).toBe(healthReads);
    expect(api.pushToast).not.toHaveBeenCalled();
  });

  it("asks about the whole app once the file chip is removed", async () => {
    api.askChat.mockImplementation(async (_company: string, _project: string, question: InspectorChatQuestion) => answered([], question, "A notes app."));
    await draw({ file: JAVA_FILE });
    await click(byId("inspector-chat-about-remove"));
    expect(byId("inspector-chat-about")).toBeNull();
    await type("What does this app do?");
    await click(byId("inspector-chat-send"));
    expect(asked()).toEqual({ message: "What does this app do?", model: BUSY });
    expect(byId("inspector-chat-log")!.querySelector('[data-testid="inspector-chat-file"]')).toBeNull();
  });

  it("shows who is writing while it waits, and Stop aborts the request and puts the question back", async () => {
    let signal: AbortSignal | undefined;
    api.askChat.mockImplementation(
      (_company: string, _project: string, _question: InspectorChatQuestion, options?: { signal?: AbortSignal }) =>
        new Promise<Reply>((_resolve, reject) => {
          signal = options?.signal;
          signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
    );
    await draw();
    await type("Which files should I read first?");
    await click(byId("inspector-chat-send"));

    expect(byId("inspector-chat-writing")!.textContent).toContain("Nemotron 3 Ultra");
    expect(byId("inspector-chat-writing")!.textContent).toContain("is writing");
    expect(byId("inspector-chat-writing")!.textContent).toContain("0s");
    expect(input().disabled).toBe(true);
    expect(byId("inspector-chat-send")).toBeNull();
    expect(byId<HTMLButtonElement>("inspector-chat-clear")!.disabled).toBe(true);

    const stopButton = byId<HTMLButtonElement>("inspector-chat-stop")!;
    await click(stopButton);
    // The Stop button is taken away, never turned into the Send button: a browser submits the form
    // of a button that becomes type="submit" during its own tap, which sent the stopped question again.
    expect(stopButton.isConnected).toBe(false);
    expect(stopButton.type).toBe("button");
    expect(byId("inspector-chat-send")).not.toBe(stopButton);
    expect(api.askChat).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(byId("inspector-chat-writing")).toBeNull();
    expect(byId("inspector-chat-notice")).toBeNull();
    expect(input().disabled).toBe(false);
    expect(input().value).toBe("Which files should I read first?");
  });

  it("keeps a question that is being answered when the chat is closed and opened again", async () => {
    let finish = () => undefined as void;
    api.askChat.mockImplementation(
      (_company: string, _project: string, question: InspectorChatQuestion) =>
        new Promise<Reply>((resolve) => {
          finish = () => resolve(answered([], question, "Start with MainActivity."));
        }),
    );
    await draw();
    await type("Which files should I read first?");
    await click(byId("inspector-chat-send"));

    // Closed to look at the file, then opened again: the question is still on its way.
    await act(async () => root.render(<QueryClientProvider client={client}><div /></QueryClientProvider>));
    expect(byId("inspector-chat")).toBeNull();
    await draw();
    expect(byId("inspector-chat-writing")).not.toBeNull();
    expect(byId("inspector-chat-log")!.textContent).toContain("Which files should I read first?");

    await act(async () => finish());
    await settle();
    expect(byId("inspector-chat-writing")).toBeNull();
    expect(byId("inspector-chat-log")!.textContent).toContain("Start with MainActivity.");
    expect(api.askChat).toHaveBeenCalledTimes(1);
  });

  it("New chat clears the conversation at once with Undo, and tells the server when the Undo window closes", async () => {
    api.chat.mockResolvedValue(view({ messages: SAVED }));
    await draw();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => byId("inspector-chat-clear")!.click());

    expect(byId("inspector-chat-log")!.textContent).not.toContain("It keeps notes.");
    expect(byId("inspector-chat-empty")).not.toBeNull();
    expect(api.clearChat).not.toHaveBeenCalled();
    expect(api.pushToast).toHaveBeenCalledTimes(1);
    expect(api.pushToast.mock.calls[0]![0]).toMatchObject({ title: "Chat cleared", action: { label: "Undo" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 50);
    });
    vi.useRealTimers();
    await settle();
    expect(api.clearChat).toHaveBeenCalledTimes(1);
    expect(api.clearChat).toHaveBeenCalledWith(COMPANY, PROJECT);
    expect(byId("inspector-chat-empty")).not.toBeNull();
    expect(client.getQueryData<InspectorChatView>(["inspector", "chat", COMPANY, PROJECT])!.messages).toEqual([]);
  });

  it("Undo brings the conversation back and the server is never asked to clear it", async () => {
    api.chat.mockResolvedValue(view({ messages: SAVED }));
    await draw();
    await click(byId("inspector-chat-clear"));
    expect(byId("inspector-chat-log")!.textContent).not.toContain("It keeps notes.");

    const toast = api.pushToast.mock.calls[0]![0] as { action: { onClick: () => void } };
    await act(async () => toast.action.onClick());
    expect(byId("inspector-chat-log")!.textContent).toContain("It keeps notes.");

    await act(async () => root.unmount());
    root = createRoot(host);
    expect(api.clearChat).not.toHaveBeenCalled();
  });

  it("closing the chat inside the Undo window still clears it", async () => {
    api.chat.mockResolvedValue(view({ messages: SAVED }));
    await draw();
    await click(byId("inspector-chat-clear"));
    expect(api.clearChat).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    await settle();
    expect(api.clearChat).toHaveBeenCalledTimes(1);
    expect(client.getQueryData<InspectorChatView>(["inspector", "chat", COMPANY, PROJECT])!.messages).toEqual([]);
  });

  it("a question sent inside the Undo window clears the old conversation first, so the new one is not lost with it", async () => {
    api.chat.mockResolvedValue(view({ messages: SAVED }));
    const order: string[] = [];
    api.clearChat.mockImplementation(async () => {
      order.push("clear");
      return { ok: true };
    });
    api.askChat.mockImplementation(async (_company: string, _project: string, question: InspectorChatQuestion) => {
      order.push("ask");
      return answered([], question, "A fresh start.");
    });
    await draw();
    await click(byId("inspector-chat-clear"));
    await type("What does this app do?");
    await click(byId("inspector-chat-send"));

    expect(order).toEqual(["clear", "ask"]);
    const log = byId("inspector-chat-log")!;
    expect(log.textContent).toContain("A fresh start.");
    expect(log.textContent).not.toContain("It keeps notes.");
    // Closing the chat afterwards has nothing left to clear.
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(api.clearChat).toHaveBeenCalledTimes(1);
  });

  it("keeps asking one of the organization's agents within reach", async () => {
    const onAskAgent = vi.fn();
    await draw({ onAskAgent });
    await click(byId("inspector-chat-agent"));
    expect(onAskAgent).toHaveBeenCalledTimes(1);
    expect(byId("inspector-chat-agent")!.textContent).toContain("Ask an agent instead");
  });

  it("says to update Automa when the server is older than the app and has no chat yet", async () => {
    api.chat.mockRejectedValue(new ApiError("API route not found", 404, { error: "API route not found" }));
    await draw({ onAskAgent: vi.fn() });
    expect(byId("server-outdated")!.textContent).toContain("The App Inspector's chat");
    expect(byId<HTMLButtonElement>("inspector-chat-send")!.disabled).toBe(true);
    // An agent can still be asked.
    expect(byId("inspector-chat-agent")).not.toBeNull();
  });
});
