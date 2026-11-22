// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectorAppInfo, InspectorProjectView, InspectorSearchHit, InspectorView } from "@/api/app-inspector";
import { ApiError } from "@/api/client";
import { __resetInspectorChat } from "./InspectorChat";
import { ProjectExplorer } from "./ProjectExplorer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  project: vi.fn(),
  info: vi.fn(),
  dir: vi.fn(),
  file: vi.fn(),
  writeFile: vi.fn(),
  search: vi.fn(),
  chat: vi.fn(),
  askChat: vi.fn(),
  clearChat: vi.fn(),
  decodeAgain: vi.fn(),
  health: vi.fn(),
  pushToast: vi.fn(),
  askAgent: vi.fn(),
}));
vi.mock("@/api/app-inspector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/app-inspector")>()),
  appInspectorApi: {
    project: api.project,
    info: api.info,
    dir: api.dir,
    file: api.file,
    writeFile: api.writeFile,
    search: api.search,
    chat: api.chat,
    askChat: api.askChat,
    clearChat: api.clearChat,
    decodeAgain: api.decodeAgain,
    imageUrl: (_company: string, _project: string, view: InspectorView, path: string) => `/image/${view}/${path}`,
    outputUrl: () => "/output",
  },
}));
vi.mock("@/api/free-models", () => ({ freeModelsApi: { health: api.health } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: api.pushToast }) }));
vi.mock("@/hooks/useAskClaude", () => ({ useAskClaude: () => ({ agent: { id: "agent-1" }, ready: true, ask: api.askAgent }) }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div data-testid="markdown">{children}</div>,
}));
// CodeMirror needs a real layout; a plain text box stands in for it.
vi.mock("@/components/studio/CodeEditor", () => ({
  CodeEditor: ({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel?: string }) => (
    <textarea data-testid="code" aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const COMPANY = "company-1";
const PROJECT = "project-1";
const MODEL = "google/gemma-4-26b-a4b-it:free";

const project: InspectorProjectView = {
  id: PROJECT,
  label: "notes.apk",
  packageName: "com.example.notes",
  dir: "/data/app-inspector/project-1",
  splitCount: 0,
  options: { resources: true, sources: true, java: true },
  status: "ready",
  decoded: true,
  java: "ready",
  hasOutput: false,
  outputName: null,
  downloadsPath: null,
  error: null,
  createdAt: "2026-11-22T00:00:00.000Z",
  logTail: "",
};
const info: InspectorAppInfo = {
  packageName: "com.example.notes",
  label: "Notes",
  versionName: "1.4.0",
  versionCode: "12",
  minSdk: "24",
  targetSdk: "35",
  iconPath: null,
  launcherActivity: "com.example.notes.MainActivity",
  debuggable: false,
  permissions: ["android.permission.INTERNET"],
  activities: ["com.example.notes.MainActivity"],
  services: [],
  receivers: [],
  providers: [],
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  window.localStorage.clear();
  __resetInspectorChat();
  for (const mock of Object.values(api)) mock.mockReset();
  api.project.mockResolvedValue({ project });
  api.info.mockResolvedValue({ info });
  api.dir.mockResolvedValue({ entries: [{ name: "AndroidManifest.xml", path: "AndroidManifest.xml", dir: false, size: 812 }] });
  api.file.mockResolvedValue({ text: "<manifest/>", truncated: false, binary: false, readOnly: false });
  api.chat.mockResolvedValue({ messages: [], models: [MODEL], defaultModel: MODEL, claude: false });
  api.health.mockResolvedValue({});
  api.askAgent.mockReturnValue(true);
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

async function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ProjectExplorer companyId={COMPANY} projectId={PROJECT} iconUrl={null} onClose={vi.fn()} />
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
const typeInto = (box: HTMLInputElement | HTMLTextAreaElement, text: string) =>
  act(async () => {
    const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
/** Types a search and waits out the box's debounce. */
async function searchFor(text: string) {
  await typeInto(byId<HTMLInputElement>("inspector-file-search")!, text);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
  await settle();
}

describe("ProjectExplorer: chat about this app", () => {
  it("opens the chat about the whole app from the header, without leaving the App Inspector", async () => {
    await draw();
    const button = byId("inspector-ask")!;
    expect(button.getAttribute("aria-label")).toBe("Chat about this app");

    await click(button);
    const chat = byId("inspector-chat")!;
    expect(chat.getAttribute("aria-label")).toBe("Chat about Notes");
    expect(byId("inspector-chat-about")).toBeNull();
    expect(byId("inspector-chat-empty")!.textContent).toContain("Ask about this app");
    expect(api.chat).toHaveBeenCalledWith(COMPANY, PROJECT);
    // Opening the chat asks nobody yet, and no agent chat was opened.
    expect(api.askAgent).not.toHaveBeenCalled();

    await click(byId("inspector-chat-close"));
    expect(byId("inspector-chat")).toBeNull();
    expect(byId("inspector-project-view")).not.toBeNull();
    expect(byId("inspector-tree")).not.toBeNull();
  });

  it("'Ask an agent instead' hands the question about this app to one of the organization's agents", async () => {
    await draw();
    await click(byId("inspector-ask"));
    await click(byId("inspector-chat-agent"));
    expect(api.askAgent).toHaveBeenCalledTimes(1);
    const question = api.askAgent.mock.calls[0]![0] as string;
    expect(question).toContain("Notes (com.example.notes)");
    expect(question).toContain("/data/app-inspector/project-1");
  });

  it("opens a file, and the editor's chat is about that file with the same ask-an-agent action", async () => {
    await draw();
    await click(document.body.querySelector('[data-testid="inspector-row"][data-path="AndroidManifest.xml"]'));
    expect(byId("inspector-editor")).not.toBeNull();

    await click(byId("inspector-chat-open"));
    expect(byId("inspector-chat")!.getAttribute("aria-label")).toBe("Chat about Notes");
    expect(byId("inspector-chat-about")!.textContent).toContain("About AndroidManifest.xml");
    await click(byId("inspector-chat-agent"));
    expect(api.askAgent).toHaveBeenCalledTimes(1);

    await click(byId("inspector-chat-close"));
    expect(byId("inspector-chat")).toBeNull();
    expect(byId("inspector-editor")).not.toBeNull();
  });
});

describe("ProjectExplorer: when something fails", () => {
  it("says the app couldn't be opened when the project fails to load, with the reason and a way to try again", async () => {
    api.project.mockRejectedValue(new ApiError("Inspector project not found", 404, { error: "Inspector project not found" }));
    await draw();
    const notice = byId("inspector-project-error")!;
    expect(notice.textContent).toContain("This app couldn't be opened.");
    expect(notice.textContent).toContain("Inspector project not found");
    expect(byId("inspector-project-view")!.textContent).not.toContain("Loading…");

    api.project.mockResolvedValue({ project });
    await click([...notice.querySelectorAll("button")].find((button) => button.textContent?.includes("Try again")));
    expect(byId("inspector-project-error")).toBeNull();
    expect(byId("inspector-tree")).not.toBeNull();
  });

  it("Info says there is no manifest when the decode failed, instead of showing loading rows forever", async () => {
    // apktool failed, Java was chosen: the tabs show, and the app's info is never asked for.
    api.project.mockResolvedValue({ project: { ...project, status: "failed", decoded: false, java: "failed", error: "apktool could not decode this APK. See the log." } });
    await draw();
    await click(byId("inspector-view-info"));
    expect(api.info).not.toHaveBeenCalled();
    const view = byId("inspector-project-view")!;
    expect(view.textContent).toContain("No manifest to read yet.");
    expect(view.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("says why a search failed instead of showing an empty list", async () => {
    api.search.mockRejectedValue(new ApiError("Could not search this app", 422, { error: "Could not search this app" }));
    await draw();
    await searchFor("main");
    expect(byId("inspector-search-error")!.textContent).toContain("Could not search this app");
    expect(byId("inspector-search-count")!.textContent).toBe("The search didn't finish");
    expect(byId("inspector-results")).toBeNull();
  });
});

describe("ProjectExplorer: search", () => {
  const hits = (count: number): InspectorSearchHit[] =>
    Array.from({ length: count }, (_, index) => ({ path: `smali/com/example/notes/Main${index}.smali`, dir: false, line: null, preview: null }));

  it("says there may be more exactly when the server stopped early", async () => {
    api.search.mockResolvedValue({ results: hits(200), truncated: true });
    await draw();
    await searchFor("main");
    expect(api.search.mock.calls[0]!.slice(0, 5)).toEqual([COMPANY, PROJECT, "files", "main", "name"]);
    expect(byId("inspector-search-count")!.textContent).toBe("200+ results");
    expect(byId("inspector-results")!.querySelectorAll('[data-testid="inspector-row"]')).toHaveLength(200);

    api.search.mockResolvedValue({ results: hits(1), truncated: false });
    await searchFor("main0");
    expect(byId("inspector-search-count")!.textContent).toBe("1 result");
  });

  it("closes the request of a search the next keystroke replaced", async () => {
    const signals: AbortSignal[] = [];
    api.search.mockImplementation(
      (_company: string, _project: string, _view: InspectorView, _query: string, _mode: string, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal!);
          signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
    );
    await draw();
    await searchFor("ma");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);

    await searchFor("main");
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });
});

describe("ProjectExplorer: after a save", () => {
  it("reads the project again, so the Built and signed banner of an APK built before the edit goes away", async () => {
    api.project.mockResolvedValue({ project: { ...project, status: "built", hasOutput: true, outputName: "Notes-automa.apk" } });
    api.writeFile.mockResolvedValue({ ok: true });
    await draw();
    expect(byId("inspector-output")!.textContent).toContain("Built and signed");

    await click(document.body.querySelector('[data-testid="inspector-row"][data-path="AndroidManifest.xml"]'));
    await typeInto(byId<HTMLTextAreaElement>("code")!, "<manifest package=\"com.example.notes2\"/>");
    // The server drops the built APK when a file changes.
    api.project.mockResolvedValue({ project: { ...project, status: "ready", hasOutput: false } });
    const reads = api.project.mock.calls.length;
    await click(byId("inspector-save"));

    expect(api.writeFile).toHaveBeenCalledWith(COMPANY, PROJECT, "AndroidManifest.xml", "<manifest package=\"com.example.notes2\"/>");
    expect(api.project.mock.calls.length).toBe(reads + 1);
    expect(byId("inspector-output")).toBeNull();
  });
});

describe("ProjectExplorer: decode again", () => {
  const decoding = { ...project, status: "decoding" as const, decoded: false, java: "none" as const };

  it("takes two taps on Info, then reads the APK again and goes back to the files", async () => {
    api.decodeAgain.mockResolvedValue({ project: decoding });
    await draw();
    await click(byId("inspector-view-info"));
    const button = () => byId<HTMLButtonElement>("inspector-decode-again-button")!;
    expect(byId("inspector-decode-again")!.textContent).toContain("any edits you made");

    await click(button());
    expect(api.decodeAgain).not.toHaveBeenCalled();
    expect(button().textContent).toContain("Tap again to replace the files");

    api.project.mockResolvedValue({ project: decoding });
    await click(button());
    expect(api.decodeAgain).toHaveBeenCalledTimes(1);
    expect(api.decodeAgain).toHaveBeenCalledWith(COMPANY, PROJECT);
    // Back on Files, which waits for apktool; the old app's info is not shown as this one's.
    expect(byId("inspector-project-view")!.textContent).toContain("The app's files appear here as soon as apktool finishes.");
    expect(byId("inspector-info")).toBeNull();
  });

  it("is offered where an app was not decoded, and where it has no Java", async () => {
    api.project.mockResolvedValue({ project: { ...project, status: "failed", decoded: false, java: "none", error: "apktool could not decode this APK. See the log." } });
    await draw();
    expect(byId("inspector-project-view")!.textContent).toContain("This app wasn't decoded.");
    expect(byId("inspector-decode-again-button")).not.toBeNull();

    api.project.mockResolvedValue({ project: { ...project, java: "none", options: { resources: true, sources: true, java: false } } });
    await act(async () => root.unmount());
    root = createRoot(host);
    await draw();
    await click(byId("inspector-view-java"));
    expect(byId("inspector-project-view")!.textContent).toContain("Java wasn't chosen when this app was decompiled.");
    expect(byId("inspector-decode-again-button")).not.toBeNull();
  });

  it("is not offered while a job is running, and says why when it is refused", async () => {
    api.project.mockResolvedValue({ project: { ...project, java: "working" } });
    await draw();
    await click(byId("inspector-view-info"));
    expect(byId<HTMLButtonElement>("inspector-decode-again-button")!.disabled).toBe(true);

    api.project.mockResolvedValue({ project });
    await act(async () => root.unmount());
    root = createRoot(host);
    await draw();
    await click(byId("inspector-view-info"));
    api.decodeAgain.mockRejectedValue(new ApiError("This project no longer has the APK it was opened from. Open the APK again instead.", 422, {}));
    await click(byId("inspector-decode-again-button"));
    await click(byId("inspector-decode-again-button"));
    expect(api.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't decode again", body: "This project no longer has the APK it was opened from. Open the APK again instead.", tone: "error" }),
    );
    // Still on Info, with the app as it was.
    expect(byId("inspector-info")).not.toBeNull();
  });
});
