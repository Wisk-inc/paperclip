// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectorChatQuestion, InspectorView } from "@/api/app-inspector";
import { __resetInspectorChat } from "./InspectorChat";
import { InspectorEditor } from "./InspectorEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  file: vi.fn(),
  writeFile: vi.fn(),
  explain: vi.fn(),
  chat: vi.fn(),
  askChat: vi.fn(),
  clearChat: vi.fn(),
  health: vi.fn(),
  pushToast: vi.fn(),
}));
vi.mock("@/api/app-inspector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/app-inspector")>()),
  appInspectorApi: {
    file: api.file,
    writeFile: api.writeFile,
    explain: api.explain,
    chat: api.chat,
    askChat: api.askChat,
    clearChat: api.clearChat,
    imageUrl: (_company: string, _project: string, view: InspectorView, path: string) => `/image/${view}/${path}`,
  },
}));
vi.mock("@/api/free-models", () => ({ freeModelsApi: { health: api.health } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: api.pushToast }) }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div data-testid="markdown">{children}</div>,
}));
// CodeMirror needs a real layout; a plain text box stands in for it.
vi.mock("@/components/studio/CodeEditor", () => ({
  CodeEditor: ({ value, onChange, readOnly, ariaLabel }: { value: string; onChange: (value: string) => void; readOnly?: boolean; ariaLabel?: string }) => (
    <textarea data-testid="code" aria-label={ariaLabel} value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const COMPANY = "company-1";
const PROJECT = "project-1";
const MODEL = "google/gemma-4-26b-a4b-it:free";
const SMALI = "smali/com/example/notes/MainActivity.smali";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  window.localStorage.clear();
  __resetInspectorChat();
  for (const mock of Object.values(api)) mock.mockReset();
  api.file.mockResolvedValue({ text: ".class public Lcom/example/notes/MainActivity;\n", truncated: false, binary: false, readOnly: false });
  api.chat.mockResolvedValue({ messages: [], models: [MODEL], defaultModel: MODEL, claude: false });
  api.health.mockResolvedValue({});
  api.clearChat.mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function draw(props: Partial<Parameters<typeof InspectorEditor>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InspectorEditor companyId={COMPANY} projectId={PROJECT} view="files" path={SMALI} building={false} appName="Notes" onClose={vi.fn()} {...props} />
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
const typeInto = (box: HTMLTextAreaElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("InspectorEditor: chat about this file", () => {
  it("opens the chat about the open file from the Sparkles button, and asks with the file's path and view", async () => {
    api.askChat.mockImplementation(async (_company: string, _project: string, question: InspectorChatQuestion) => {
      const reply = { id: "a1", role: "assistant" as const, text: "It is the app's first screen.", at: "2026-11-22T12:00:01.000Z", model: question.model };
      return { reply, messages: [{ id: "q1", role: "user" as const, text: question.message, at: "2026-11-22T12:00:00.000Z", path: question.path ?? null, view: question.view }, reply] };
    });
    const onAskAgent = vi.fn();
    await draw({ onAskAgent });

    const button = byId("inspector-chat-open")!;
    expect(button.getAttribute("aria-label")).toBe("Chat about this file");
    // The one-shot explanation that needed an Anthropic key is gone.
    expect(byId("inspector-explain")).toBeNull();
    expect(byId("inspector-chat")).toBeNull();

    await click(button);
    const chat = byId("inspector-chat")!;
    expect(chat.textContent).toContain("Notes");
    expect(byId("inspector-chat-about")!.textContent).toContain("About MainActivity.smali");
    expect(api.chat).toHaveBeenCalledWith(COMPANY, PROJECT);

    await typeInto(byId<HTMLTextAreaElement>("inspector-chat-input")!, "Explain what this file does");
    await click(byId("inspector-chat-send"));
    expect(api.askChat.mock.calls[0]![2]).toEqual({ message: "Explain what this file does", path: SMALI, view: "files", model: MODEL });
    expect(byId("inspector-chat-log")!.textContent).toContain("It is the app's first screen.");
    expect(api.explain).not.toHaveBeenCalled();
    expect(byId("inspector-explanation")).toBeNull();

    await click(byId("inspector-chat-agent"));
    expect(onAskAgent).toHaveBeenCalledTimes(1);
  });

  it("closing the chat returns to the editor with unsaved text intact", async () => {
    await draw();
    const code = () => byId<HTMLTextAreaElement>("code")!;
    await typeInto(code(), ".class public Lcom/example/notes/MainActivity;\n# changed\n");
    expect(byId<HTMLButtonElement>("inspector-save")!.disabled).toBe(false);

    await click(byId("inspector-chat-open"));
    expect(byId("inspector-chat")).not.toBeNull();
    // The model reads the file on disk, so the chat says the question is about the saved one.
    expect(byId("inspector-chat-about")!.textContent).toContain("as last saved");

    await click(byId("inspector-chat-close"));
    expect(byId("inspector-chat")).toBeNull();
    expect(byId("inspector-editor")).not.toBeNull();
    expect(code().value).toBe(".class public Lcom/example/notes/MainActivity;\n# changed\n");
    expect(byId<HTMLButtonElement>("inspector-save")!.disabled).toBe(false);
    expect(api.file).toHaveBeenCalledTimes(1);
  });

  it("has no chat button for a file that can't be read as text", async () => {
    api.file.mockResolvedValue({ text: "", truncated: false, binary: true, readOnly: true });
    await draw({ path: "lib/arm64-v8a/libnotes.so" });
    expect(byId("inspector-binary")).not.toBeNull();
    expect(byId("inspector-chat-open")).toBeNull();
  });
});

describe("InspectorEditor: why a file can't be saved", () => {
  it.each([
    ["decompiled Java", { view: "java" as const, path: "com/example/notes/MainActivity.java" }, { truncated: false }, "Decompiled Java is for reading"],
    ["a file larger than what is shown", { path: "assets/big.json" }, { truncated: true }, "Larger than 2 MB"],
    ["text that is not UTF-8", { path: "assets/legacy.txt" }, { truncated: false }, "isn't saved as UTF-8"],
  ])("says the reason for %s", async (_case, props, data, reason) => {
    api.file.mockResolvedValue({ text: "caf\uFFFD\n", binary: false, readOnly: true, ...data });
    await draw(props);
    const note = byId("inspector-read-only");
    expect(note?.textContent).toContain(reason);
    // One reason, not another file's.
    for (const other of ["Decompiled Java is for reading", "Larger than 2 MB", "isn't saved as UTF-8"]) {
      if (other !== reason) expect(note?.textContent).not.toContain(other);
    }
    expect(byId<HTMLTextAreaElement>("code")!.readOnly).toBe(true);
  });

  it("says nothing over a file that can be saved", async () => {
    await draw();
    expect(byId("inspector-read-only")).toBeNull();
  });
});
