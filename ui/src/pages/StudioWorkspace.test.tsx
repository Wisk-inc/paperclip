// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioAssistantTurn, StudioFileNode } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { StudioWorkspace } from "./StudioWorkspace";

const mockStudioApi = vi.hoisted(() => ({
  get: vi.fn(),
  catalog: vi.fn(),
  tree: vi.fn(),
  messages: vi.fn(),
  changes: vi.fn(),
  collaborators: vi.fn(),
  aiKeys: vi.fn(),
  assistant: vi.fn(),
  console: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  move: vi.fn(),
  deleteEntry: vi.fn(),
  stop: vi.fn(),
  run: vi.fn(),
  installToolchain: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  undoEdit: vi.fn(),
  restoreCheckpoint: vi.fn(),
  shareInfo: vi.fn(),
  askAssistant: vi.fn(),
  complete: vi.fn(),
  archiveUrl: vi.fn(() => "/archive.zip"),
  downloadUrl: vi.fn(() => "/download"),
  rawUrl: vi.fn(() => "/raw"),
}));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSocketSend = vi.hoisted(() => vi.fn());
/** The browser's own fetch: the page uses it only for the save it sends while leaving. */
const mockFetch = vi.hoisted(() => vi.fn());
const mockEditor = vi.hoisted(() => ({ suggest: null as null | ((input: { prefix: string; suffix: string }, signal: AbortSignal) => Promise<string>) }));
const mockTree = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => Promise<void> | void),
  remove: null as null | ((path: string) => void),
}));

vi.mock("../api/studio", () => ({ studioApi: mockStudioApi, studioSocketUrl: () => "ws://studio.test" }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => undefined }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast, dismissToast: () => undefined, clearToasts: () => undefined }) }));
const socketEvents = vi.hoisted(() => ({
  handler: null as null | ((event: unknown) => void),
  /** Says what the socket is: "open", or "closed" while it reconnects. */
  setStatus: null as null | ((status: "open" | "closed") => void),
}));
vi.mock("../hooks/useStudioSocket", async () => {
  const { useState } = await import("react");
  return {
    useStudioSocket: (_url: string | null, onEvent: (event: unknown) => void) => {
      socketEvents.handler = onEvent;
      const [status, setStatus] = useState<"open" | "closed">("open");
      socketEvents.setStatus = setStatus;
      return { status, send: mockSocketSend };
    },
  };
});
vi.mock("../hooks/useNarrowScreen", () => ({ useNarrowScreen: () => false }));
// A delete goes to the server at once here, without the wait for Undo. Like the real one, a failed delete only brings the item back.
vi.mock("../hooks/useUndoableAction", () => ({
  useUndoableAction: ({ commit }: { commit: (id: string) => Promise<unknown> }) => ({
    hiddenIds: new Set<string>(),
    run: (id: string) => void commit(id).catch(() => undefined),
  }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: "/studio/ws-1", search: "", hash: "", state: null }),
  useNavigate: () => () => undefined,
  useParams: () => ({ workspaceId: "ws-1" }),
}));
// The panes are tested on their own; here they only need to be there.
vi.mock("../components/studio/CodeEditor", () => ({
  CodeEditor: ({ path, value, onChange, suggest }: { path: string; value: string; onChange?: (value: string) => void; suggest?: typeof mockEditor.suggest }) => {
    mockEditor.suggest = suggest ?? null;
    return <textarea aria-label="editor" data-path={path} value={value} onChange={(event) => onChange?.(event.target.value)} />;
  },
}));
vi.mock("../components/studio/StudioFileTree", () => ({
  StudioFileTree: ({
    tree,
    onOpen,
    onRename,
    onDelete,
  }: {
    tree: StudioFileNode[];
    onOpen: (path: string) => void;
    onRename?: (from: string, to: string) => Promise<void> | void;
    onDelete?: (path: string) => void;
  }) => {
    mockTree.rename = onRename ?? null;
    mockTree.remove = onDelete ?? null;
    return (
      <div>
        {tree.map((node) => (
          <button key={node.path} type="button" data-open={node.path} onClick={() => onOpen(node.path)}>
            {node.path}
          </button>
        ))}
      </div>
    );
  },
}));
// What the page hands the AI pane, the preview and the Checkpoints sheet, as last drawn.
interface AssistantPaneProps {
  turns: StudioAssistantTurn[];
  turnsLoaded?: boolean;
  onSend: (message: string, provider: string, model: string) => Promise<void>;
  onUndo: (checkpointId: string) => Promise<void>;
  onUndoEdit: (editId: string) => Promise<void>;
}
const mockPanes = vi.hoisted(() => ({
  assistant: null as null | AssistantPaneProps,
  /** Each draw of the AI pane: whether the transcript had arrived, and how many turns it was given. */
  assistantDraws: [] as Array<{ turnsLoaded: boolean | undefined; turns: number }>,
  preview: null as null | { starting?: boolean; onRun?: () => void },
  checkpoints: null as null | { onRestored: (checkpoint: { id: string; label: string }) => void; returnFocusRef?: { current: HTMLElement | null } },
  team: null as null | { shareEnabled: boolean; shareCode: string | null; share: null | { code: string; inviteUrl: string | null; localInviteUrl: string } },
}));
vi.mock("../components/studio/StudioAssistant", () => ({
  StudioAssistant: (props: AssistantPaneProps) => {
    mockPanes.assistant = props;
    mockPanes.assistantDraws.push({ turnsLoaded: props.turnsLoaded, turns: props.turns.length });
    return null;
  },
}));
vi.mock("../components/studio/StudioTeamPanel", () => ({
  StudioTeamPanel: (props: NonNullable<typeof mockPanes.team>) => {
    mockPanes.team = props;
    return null;
  },
}));
vi.mock("../components/studio/StudioPreview", () => ({
  StudioPreview: (props: NonNullable<typeof mockPanes.preview>) => {
    mockPanes.preview = props;
    return null;
  },
}));
vi.mock("../components/studio/StudioConsole", () => ({ StudioConsole: () => null }));
vi.mock("../components/studio/StudioAssets", () => ({ StudioAssets: () => null }));
vi.mock("../components/studio/StudioCheckpointsSheet", () => ({
  StudioCheckpointsSheet: (props: NonNullable<typeof mockPanes.checkpoints>) => {
    mockPanes.checkpoints = props;
    return null;
  },
}));
vi.mock("../components/AppearancePicker", () => ({ AppearancePicker: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = {
  id: "ws-1",
  companyId: "company-1",
  name: "Recipe box",
  language: "node",
  description: null,
  sourceUrl: null,
  runCommand: null,
  createdByUserId: null,
  shareCode: null,
  shareEnabled: false,
  shareExpiresAt: null,
  lastRunAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

async function settle() {
  for (let index = 0; index < 5; index += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("StudioWorkspace", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    // Each test starts with no tabs remembered from the one before.
    window.localStorage.removeItem("automa.studio.tabs.ws-1");
    mockStudioApi.get.mockResolvedValue({ workspace, run: null, assistantRunning: false, participants: [], toolchain: null });
    mockStudioApi.catalog.mockResolvedValue({ languages: [], cloudflared: false });
    mockStudioApi.tree.mockResolvedValue({
      tree: [
        { name: "app.js", path: "app.js", type: "file" },
        { name: "other.js", path: "other.js", type: "file" },
      ],
    });
    mockStudioApi.messages.mockResolvedValue({ messages: [] });
    mockStudioApi.changes.mockResolvedValue({ changeRequests: [] });
    mockStudioApi.collaborators.mockResolvedValue({ collaborators: [] });
    mockStudioApi.aiKeys.mockResolvedValue({ keys: [] });
    mockStudioApi.assistant.mockResolvedValue({ turns: [], running: false });
    mockStudioApi.console.mockResolvedValue({ lines: [] });
    mockStudioApi.readFile.mockImplementation(async (_id: string, path: string) => ({ path, content: `// ${path}`, version: "v1", size: 10 }));
    mockStudioApi.move.mockResolvedValue({ ok: true });
    mockStudioApi.deleteEntry.mockResolvedValue({ ok: true });
    // A save answers with a new version unless the test says otherwise (and nothing is left over from the test before).
    mockStudioApi.writeFile.mockReset();
    mockStudioApi.writeFile.mockImplementation(async (_id: string, input: { path: string; content: string }) => ({ path: input.path, content: input.content, version: "v2", size: input.content.length, binary: false }));
    mockPanes.assistant = null;
    mockPanes.assistantDraws = [];
    mockPanes.preview = null;
    mockPanes.checkpoints = null;
    mockPanes.team = null;
    mockStudioApi.shareInfo.mockResolvedValue({ share: null });
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { path: string; content: string };
      return { ok: true, status: 200, json: async () => ({ path: sent.path, content: sent.content, version: "v-left", size: sent.content.length, binary: false }) };
    });
    vi.stubGlobal("fetch", mockFetch);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const draw = async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <StudioWorkspace />
        </QueryClientProvider>,
      ),
    );
    await settle();
  };
  const editor = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="editor"]')!;
  const type = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), value);
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const openFromTree = async (path: string) => {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-open="${path}"]`)!.click());
    await settle();
  };
  /** The open-file tabs as their paths, with a * on the one in the editor. */
  const tabs = () =>
    [...container.querySelectorAll<HTMLButtonElement>('[data-testid="studio-file-tab"]')].map((tab) => `${tab.dataset.path}${tab.getAttribute("aria-selected") === "true" ? "*" : ""}`);
  const tab = (path: string) => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="studio-file-tab"]')].find((item) => item.dataset.path === path)!;
  const closeTab = async (name: string) => {
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Close ${name}"]`)!.click());
    await settle();
  };
  const openFileLabel = () => container.querySelector('[data-testid="studio-open-file"]')!.textContent;
  const file = (path: string): StudioFileNode => ({ name: path.split("/").pop()!, path, type: "file" });
  const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const saveState = () => container.querySelector('[data-testid="studio-save-state"]')!.textContent;
  /** The banner that offers "Load theirs" and "Keep mine". */
  const conflictShown = () => container.textContent!.includes("This file changed somewhere else");
  /** The socket drops and comes back, as when a phone is locked and opened again. */
  const reconnect = async () => {
    await act(async () => socketEvents.setStatus!("closed"));
    await act(async () => socketEvents.setStatus!("open"));
    await settle();
  };
  const showSide = async (id: "console" | "preview" | "ai" | "team") => {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="studio-side-tab-${id}"]`)!.click());
    await settle();
  };
  /** What reading any file returns from now on. */
  const serverHas = (content: string, version: string) =>
    mockStudioApi.readFile.mockImplementation(async (_id: string, path: string) => ({ path, content, version, size: content.length }));
  /** A save that answers when the test says so. */
  const heldSaves = () => {
    const answers: Array<(version: string) => void> = [];
    mockStudioApi.writeFile.mockImplementation(
      (_id: string, input: { path: string; content: string }) =>
        new Promise((resolve) => answers.push((version) => resolve({ path: input.path, content: input.content, version, size: input.content.length, binary: false }))),
    );
    return answers;
  };
  const turn = (id: string, role: "user" | "assistant", minute: number): StudioAssistantTurn => ({
    id,
    role,
    text: id,
    steps: [],
    provider: "free",
    model: "m",
    error: null,
    createdAt: `2026-10-01T00:0${minute}:00.000Z`,
  });
  const turnIds = () => mockPanes.assistant!.turns.map((item) => item.id);

  it("fetches the people list again when a guest joins, so they can be removed straight away", async () => {
    await draw();
    const owner = { id: "owner", name: "Owner", role: "owner", color: "var(--chart-1)", online: true, activePath: null };
    const sam = { id: "guest:c-1", name: "Sam", role: "guest", color: "var(--chart-2)", online: true, activePath: null };
    await act(async () => socketEvents.handler!({ type: "hello", you: owner, participants: [owner] }));
    const before = mockStudioApi.collaborators.mock.calls.length;
    // Someone only moving to another file: no refetch.
    await act(async () => socketEvents.handler!({ type: "presence", participants: [{ ...owner, activePath: "app.js" }] }));
    await settle();
    expect(mockStudioApi.collaborators.mock.calls.length).toBe(before);
    // Sam joins.
    await act(async () => socketEvents.handler!({ type: "presence", participants: [owner, sam] }));
    await settle();
    expect(mockStudioApi.collaborators.mock.calls.length).toBe(before + 1);
  });

  it("keeps edits that did not save open instead of switching files", async () => {
    mockStudioApi.writeFile.mockRejectedValue(new Error("Network down"));
    await draw();
    expect(editor().dataset.path).toBe("app.js");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), "my unsaved work");
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-open="other.js"]')!.click());
    await settle();

    expect(mockStudioApi.writeFile).toHaveBeenCalledTimes(1);
    expect(mockStudioApi.readFile).not.toHaveBeenCalledWith("ws-1", "other.js");
    expect(editor().dataset.path).toBe("app.js");
    expect(editor().value).toBe("my unsaved work");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't save app.js", tone: "error" }));

    // Once saving works again, the same tap opens the other file.
    mockStudioApi.writeFile.mockResolvedValue({ path: "app.js", version: "v2" });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-open="other.js"]')!.click());
    await settle();
    expect(editor().dataset.path).toBe("other.js");
  });

  it("says when the AI keys can't load, since a saved key would look missing", async () => {
    mockStudioApi.aiKeys.mockRejectedValue(new Error("Server unreachable"));
    await draw();
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't load your AI keys", body: "Server unreachable. The free models still work.", tone: "error" }));
  });

  it("rests suggestions for 30 seconds after one fails, instead of asking after every pause", async () => {
    window.localStorage.removeItem("automa.studio.suggest");
    await draw();
    const ask = () => mockEditor.suggest!({ prefix: "const total = ", suffix: "" }, new AbortController().signal);

    // The server answers 200 and says why in `error`.
    mockStudioApi.complete.mockResolvedValue({ completion: "", model: "m", error: "The free models hit today's limit" });
    await expect(ask()).rejects.toThrow("The free models hit today's limit");
    await expect(ask()).resolves.toBe("");
    expect(mockStudioApi.complete).toHaveBeenCalledTimes(1);

    // Half a minute later it asks again.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    mockStudioApi.complete.mockResolvedValue({ completion: "0;", model: "m" });
    await expect(ask()).resolves.toBe("0;");
    expect(mockStudioApi.complete).toHaveBeenCalledTimes(2);
    clock.mockRestore();

    // A request that fails outright rests them too; turning suggestions off and on asks at once.
    mockStudioApi.complete.mockRejectedValue(new Error("Network down"));
    await expect(ask()).rejects.toThrow("Network down");
    await expect(ask()).resolves.toBe("");
    expect(mockStudioApi.complete).toHaveBeenCalledTimes(3);
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="studio-suggest-toggle"]')!;
    await act(async () => toggle.click());
    expect(mockEditor.suggest).toBeNull();
    await act(async () => toggle.click());
    mockStudioApi.complete.mockResolvedValue({ completion: "1;", model: "m" });
    await expect(ask()).resolves.toBe("1;");
    expect(mockStudioApi.complete).toHaveBeenCalledTimes(4);

    // Typing again cancels an ask; that is not a failure.
    const typing = new AbortController();
    mockStudioApi.complete.mockImplementation(async () => {
      typing.abort();
      throw new DOMException("The user aborted a request.", "AbortError");
    });
    await expect(mockEditor.suggest!({ prefix: "const total = ", suffix: "" }, typing.signal)).rejects.toHaveProperty("name", "AbortError");
    mockStudioApi.complete.mockResolvedValue({ completion: "2;", model: "m" });
    await expect(ask()).resolves.toBe("2;");
    expect(mockStudioApi.complete).toHaveBeenCalledTimes(6);
  });

  it("leaves no error behind when a project that is gone can't load its console", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      mockStudioApi.console.mockRejectedValue(new Error("Studio project not found"));
      await draw();
      // Give Node the moment it takes to report a rejection nothing handled.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(mockStudioApi.console).toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("says when the new version of the open file can't load, keeping the open copy", async () => {
    await draw();
    expect(editor().dataset.path).toBe("app.js");
    mockStudioApi.readFile.mockRejectedValue(new Error("Network down"));
    // Someone else saved app.js; its content is too large to come with the event.
    await act(async () => socketEvents.handler!({ type: "file:saved", path: "app.js", version: "v2", content: null }));
    await settle();
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't load the new version of app.js", body: "Network down", tone: "error" }),
    );
    expect(editor().value).toBe("// app.js");
  });

  it("gives every opened file a tab and switches between them", async () => {
    await draw();
    // The first file on load has its tab.
    expect(tabs()).toEqual(["app.js*"]);
    expect(openFileLabel()).toBe("app.js");

    await openFromTree("other.js");
    expect(tabs()).toEqual(["app.js", "other.js*"]);
    expect(openFileLabel()).toBe("other.js");
    expect(editor().dataset.path).toBe("other.js");

    // Back through the tab: the file is read again and its tab stays where it was.
    mockStudioApi.readFile.mockClear();
    await act(async () => tab("app.js").click());
    await settle();
    expect(mockStudioApi.readFile).toHaveBeenCalledWith("ws-1", "app.js");
    expect(tabs()).toEqual(["app.js*", "other.js"]);
    expect(editor().dataset.path).toBe("app.js");

    // The tab of the file already in the editor reads nothing.
    mockStudioApi.readFile.mockClear();
    await act(async () => tab("app.js").click());
    await settle();
    expect(mockStudioApi.readFile).not.toHaveBeenCalled();
  });

  it("saves the open file before its tab closes, then shows the tab beside it, or nothing after the last one", async () => {
    mockStudioApi.writeFile.mockResolvedValue({ path: "app.js", version: "v2" });
    await draw();
    await openFromTree("other.js");
    await act(async () => tab("app.js").click());
    await settle();
    expect(tabs()).toEqual(["app.js*", "other.js"]);

    await type("edited before closing");
    expect(container.querySelector('[data-testid="studio-file-tab-edited"]')).not.toBeNull();
    await closeTab("app.js");
    expect(mockStudioApi.writeFile).toHaveBeenCalledWith("ws-1", { path: "app.js", content: "edited before closing", baseVersion: "v1" });
    expect(tabs()).toEqual(["other.js*"]);
    expect(editor().dataset.path).toBe("other.js");

    await closeTab("other.js");
    expect(tabs()).toEqual([]);
    expect(openFileLabel()).toBe("No file open");
    expect(container.querySelector('textarea[aria-label="editor"]')).toBeNull();
    expect(container.textContent).toContain("Pick a file to edit, or make a new one.");
    expect(container.querySelector('[data-testid="studio-save-state"]')!.textContent).toBe("");
    // Everyone else is told this person is on no file now.
    expect(mockSocketSend).toHaveBeenLastCalledWith({ type: "focus", path: null });
  });

  it("keeps the open file's tab when its edits can't be saved, and says why", async () => {
    mockStudioApi.writeFile.mockRejectedValue(new Error("Network down"));
    await draw();
    await openFromTree("other.js");
    await type("work that must not be lost");
    mockStudioApi.readFile.mockClear();

    await closeTab("other.js");
    expect(tabs()).toEqual(["app.js", "other.js*"]);
    expect(editor().dataset.path).toBe("other.js");
    expect(editor().value).toBe("work that must not be lost");
    expect(mockStudioApi.readFile).not.toHaveBeenCalled();
    expect(mockPushToast).toHaveBeenCalledWith({ title: "Couldn't save other.js", body: "The tab stays open so your edits are not lost.", tone: "error" });
    expect(container.querySelector('[data-testid="studio-save-state"]')!.textContent).toBe("Not saved");

    // Once saving works again, the same tap closes it.
    mockStudioApi.writeFile.mockResolvedValue({ path: "other.js", version: "v2" });
    await closeTab("other.js");
    expect(tabs()).toEqual(["app.js*"]);
  });

  it("closes a tab that is not the open file without saving or reading anything", async () => {
    await draw();
    await openFromTree("other.js");
    await type("still typing here");
    mockStudioApi.readFile.mockClear();

    await closeTab("app.js");
    expect(tabs()).toEqual(["other.js*"]);
    expect(editor().value).toBe("still typing here");
    expect(mockStudioApi.writeFile).not.toHaveBeenCalled();
    expect(mockStudioApi.readFile).not.toHaveBeenCalled();
  });

  it("renames the tabs of a renamed file, open or not", async () => {
    await draw();
    await openFromTree("other.js");
    expect(tabs()).toEqual(["app.js", "other.js*"]);

    // The file in the editor.
    mockStudioApi.tree.mockResolvedValue({ tree: [file("app.js"), file("second.js")] });
    await act(async () => mockTree.rename!("other.js", "second.js"));
    await settle();
    expect(mockStudioApi.move).toHaveBeenCalledWith("ws-1", { from: "other.js", to: "second.js" });
    expect(tabs()).toEqual(["app.js", "second.js*"]);
    expect(openFileLabel()).toBe("second.js");
    expect(editor().dataset.path).toBe("second.js");

    // A file that only has a tab.
    mockStudioApi.tree.mockResolvedValue({ tree: [file("main.js"), file("second.js")] });
    await act(async () => mockTree.rename!("app.js", "main.js"));
    await settle();
    expect(tabs()).toEqual(["main.js", "second.js*"]);
    expect(editor().dataset.path).toBe("second.js");
  });

  it("moves the tabs of every open file in a renamed folder, even when the tree is read again before the move answers", async () => {
    mockStudioApi.tree.mockResolvedValue({ tree: [file("app.js"), file("src/one.js"), file("src/two.js")] });
    await draw();
    await openFromTree("src/one.js");
    await openFromTree("src/two.js");
    expect(tabs()).toEqual(["app.js", "src/one.js", "src/two.js*"]);

    // The server announces the change to the tree before it answers the move.
    mockStudioApi.move.mockImplementation(async () => {
      mockStudioApi.tree.mockResolvedValue({ tree: [file("app.js"), file("code/one.js"), file("code/two.js")] });
      socketEvents.handler!({ type: "tree:changed" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ok: true };
    });
    await act(async () => mockTree.rename!("src", "code"));
    await settle();
    expect(tabs()).toEqual(["app.js", "code/one.js", "code/two.js*"]);
    expect(editor().dataset.path).toBe("code/two.js");
  });

  it("leaves the tabs alone when a rename fails", async () => {
    await draw();
    await openFromTree("other.js");
    mockStudioApi.move.mockRejectedValue(new Error("That name is taken"));
    await act(async () => mockTree.rename!("app.js", "other.js"));
    await settle();
    expect(tabs()).toEqual(["app.js", "other.js*"]);
    expect(mockPushToast).toHaveBeenCalledWith({ title: "Couldn't rename", body: "That name is taken", tone: "error" });
  });

  it("closes the tab of a file deleted somewhere else, and opens the tab beside it when it was the open file", async () => {
    await draw();
    await openFromTree("other.js");
    expect(tabs()).toEqual(["app.js", "other.js*"]);

    // A file that only has a tab: it goes quietly.
    await act(async () => socketEvents.handler!({ type: "file:saved", path: "app.js", version: "deleted", content: null }));
    await settle();
    expect(tabs()).toEqual(["other.js*"]);
    expect(mockPushToast).not.toHaveBeenCalled();

    // The open file, with edits that are not saved: they are not written back.
    await openFromTree("app.js");
    expect(tabs()).toEqual(["other.js", "app.js*"]);
    await type("typed just before it was deleted");
    await act(async () => socketEvents.handler!({ type: "file:saved", path: "app.js", version: "deleted", content: null }));
    await settle();
    expect(mockPushToast).toHaveBeenCalledWith({ title: "app.js was deleted", tone: "info" });
    expect(tabs()).toEqual(["other.js*"]);
    expect(editor().dataset.path).toBe("other.js");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
    expect(mockStudioApi.writeFile).not.toHaveBeenCalled();
  });

  it("closes the tabs of a file or folder deleted from the tree", async () => {
    mockStudioApi.tree.mockResolvedValue({ tree: [file("app.js"), file("src/one.js"), file("src/two.js")] });
    await draw();
    await openFromTree("src/one.js");
    await openFromTree("src/two.js");
    expect(tabs()).toEqual(["app.js", "src/one.js", "src/two.js*"]);

    mockStudioApi.tree.mockResolvedValue({ tree: [file("app.js"), file("src/two.js")] });
    await act(async () => mockTree.remove!("src/one.js"));
    await settle();
    expect(mockStudioApi.deleteEntry).toHaveBeenCalledWith("ws-1", "src/one.js");
    expect(tabs()).toEqual(["app.js", "src/two.js*"]);

    // The folder goes, and with it the open file: the tab that is left opens.
    mockStudioApi.tree.mockResolvedValue({ tree: [file("app.js")] });
    await act(async () => mockTree.remove!("src"));
    await settle();
    expect(tabs()).toEqual(["app.js*"]);
    expect(editor().dataset.path).toBe("app.js");
  });

  it("closes the tab of a file someone else removed, once the tree no longer lists it", async () => {
    await draw();
    await openFromTree("other.js");
    await act(async () => tab("app.js").click());
    await settle();
    mockStudioApi.tree.mockResolvedValue({ tree: [file("app.js")] });
    await act(async () => socketEvents.handler!({ type: "tree:changed" }));
    await settle();
    expect(tabs()).toEqual(["app.js*"]);
  });

  it("remembers the tabs and the open file, and forgets files that are gone", async () => {
    await draw();
    await openFromTree("other.js");
    expect(JSON.parse(window.localStorage.getItem("automa.studio.tabs.ws-1")!)).toEqual({ tabs: ["app.js", "other.js"], active: "other.js" });

    // Coming back later: one remembered file was deleted meanwhile.
    await act(async () => root.unmount());
    window.localStorage.setItem("automa.studio.tabs.ws-1", JSON.stringify({ tabs: ["gone.js", "app.js", "other.js"], active: "other.js" }));
    root = createRoot(container);
    await draw();
    expect(tabs()).toEqual(["app.js", "other.js*"]);
    expect(editor().dataset.path).toBe("other.js");
    expect(mockStudioApi.readFile).not.toHaveBeenCalledWith("ws-1", "gone.js");
    expect(JSON.parse(window.localStorage.getItem("automa.studio.tabs.ws-1")!)).toEqual({ tabs: ["app.js", "other.js"], active: "other.js" });
  });

  it("keeps at most twelve tabs, closing the oldest", async () => {
    const paths = Array.from({ length: 13 }, (_, index) => `file-${index}.js`);
    mockStudioApi.tree.mockResolvedValue({ tree: paths.map(file) });
    await draw();
    // file-0.js opened on load; the rest follow one by one.
    for (const path of paths.slice(1)) await openFromTree(path);
    expect(tabs()).toEqual([...paths.slice(1, 12), "file-12.js*"]);
  });

  it("shows the save state and the AI suggestions switch under the editor", async () => {
    mockStudioApi.writeFile.mockResolvedValue({ path: "app.js", version: "v2" });
    await draw();
    const saveState = () => container.querySelector('[data-testid="studio-save-state"]')!.textContent;
    expect(saveState()).toBe("Saved");
    await type("one more line");
    expect(saveState()).toBe("Edited");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
    expect(saveState()).toBe("Saved");
    expect(container.querySelector('[data-testid="studio-editor-status"] [data-testid="studio-suggest-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="studio-file-language"]')!.textContent).toBe("JavaScript");
    // Wide screens have the file list beside the editor, so the strip needs no +, and no key row.
    expect(container.querySelector('[data-testid="studio-file-tab-add"]')).toBeNull();
    expect(container.querySelector('[data-testid="studio-key-row"]')).toBeNull();
  });

  it("names every side panel tab, with only the open one spelled out", async () => {
    await draw();
    const sideTabs = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Side panel"] [role="tab"]')];
    expect(sideTabs.map((item) => item.getAttribute("aria-label"))).toEqual(["Console", "Preview", "AI", "Stats", "Team"]);
    expect(sideTabs.map((item) => item.title)).toEqual(["Console", "Preview", "AI", "Stats", "Team"]);
    // The other names are in the page for when the row is wide enough; they are hidden until then.
    const hidden = (item: HTMLButtonElement) => item.querySelector("span.truncate")!.className.includes("hidden");
    expect(sideTabs.map(hidden)).toEqual([false, true, true, true, true]);
    await act(async () => sideTabs[2]!.click());
    expect(sideTabs.map(hidden)).toEqual([true, true, false, true, true]);
  });

  it("says when Stop fails instead of doing nothing", async () => {
    mockStudioApi.get.mockResolvedValue({ workspace, run: { status: "running", startedAt: "2026-10-01T00:00:00.000Z" }, assistantRunning: false, participants: [], toolchain: null });
    mockStudioApi.stop.mockRejectedValue(new Error("The app didn't answer"));
    await draw();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="studio-stop"]')!.click());
    await settle();
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't stop the app", body: "The app didn't answer", tone: "error" }));
  });

  // ── What the socket did not bring ───────────────────────────────────────
  it("reads the open file again when the socket reconnects, so a change made meanwhile shows", async () => {
    mockStudioApi.writeFile.mockImplementation(async (_id: string, input: { path: string }) => ({ path: input.path, version: "v3" }));
    await draw();
    expect(editor().value).toBe("// app.js");
    // The AI rewrote app.js while the phone was locked.
    serverHas("// rewritten by the AI", "v2");
    await reconnect();
    expect(editor().value).toBe("// rewritten by the AI");
    expect(saveState()).toBe("Saved");
    // The next edit is saved on top of the new version: no "changed somewhere else".
    await type("// rewritten by the AI, then by me");
    await wait(900);
    expect(mockStudioApi.writeFile).toHaveBeenCalledWith("ws-1", { path: "app.js", content: "// rewritten by the AI, then by me", baseVersion: "v2" });
    expect(conflictShown()).toBe(false);
  });

  it("offers the choice when the open file changed while the socket was down and has edits that are not saved", async () => {
    mockStudioApi.writeFile.mockRejectedValue(new ApiError("Can't reach Automa right now.", 0, null));
    await draw();
    await type("typed while offline");
    await wait(900);
    expect(saveState()).toBe("Not saved");
    serverHas("// rewritten by the AI", "v2");
    mockStudioApi.writeFile.mockClear();
    await reconnect();
    expect(conflictShown()).toBe(true);
    expect(editor().value).toBe("typed while offline");
    // Nothing is written over the newer version until the person chooses.
    await wait(1700);
    expect(mockStudioApi.writeFile).not.toHaveBeenCalled();
  });

  it("closes the open file when it is gone after a reconnect, like a file deleted somewhere else", async () => {
    await draw();
    await openFromTree("other.js");
    expect(tabs()).toEqual(["app.js", "other.js*"]);
    mockStudioApi.readFile.mockImplementation(async (_id: string, path: string) => {
      if (path === "other.js") throw new ApiError("File not found", 404, null);
      return { path, content: `// ${path}`, version: "v1", size: 10 };
    });
    await reconnect();
    expect(mockPushToast).toHaveBeenCalledWith({ title: "other.js was deleted", tone: "info" });
    expect(tabs()).toEqual(["app.js*"]);
    expect(editor().dataset.path).toBe("app.js");
  });

  it("reads the open file again after going back to a checkpoint, whether or not the socket says so", async () => {
    await draw();
    serverHas("// as it was yesterday", "v0");
    await act(async () => mockPanes.checkpoints!.onRestored({ id: "c-1", label: "Yesterday" }));
    await settle();
    expect(editor().value).toBe("// as it was yesterday");
    expect(saveState()).toBe("Saved");
  });

  it("reads the open file again after undoing a change the AI made", async () => {
    mockStudioApi.undoEdit.mockResolvedValue({ path: "app.js", undoId: "undo-1" });
    mockStudioApi.restoreCheckpoint.mockResolvedValue({ restored: { id: "c-1", label: "Before the AI" }, safety: { id: "c-2", label: "Safety" } });
    await draw();
    await showSide("ai");
    // The Undo beside one step.
    serverHas("// before the AI's change", "v0");
    await act(async () => mockPanes.assistant!.onUndoEdit("edit-1"));
    await settle();
    expect(editor().value).toBe("// before the AI's change");
    // Undo of a whole reply goes back to the checkpoint saved before it.
    serverHas("// before the AI's reply", "v00");
    await act(async () => mockPanes.assistant!.onUndo("c-1"));
    await settle();
    expect(mockStudioApi.restoreCheckpoint).toHaveBeenCalledWith("ws-1", "c-1");
    expect(editor().value).toBe("// before the AI's reply");
  });

  it("forgets who was typing when the socket says hello again", async () => {
    await draw();
    const owner = { id: "owner", name: "Owner", role: "owner", color: "var(--chart-1)", online: true, activePath: null };
    const ann = { id: "guest:c-1", name: "Ann", role: "guest", color: "var(--chart-2)", online: true, activePath: "app.js" };
    await act(async () => socketEvents.handler!({ type: "hello", you: owner, participants: [owner, ann] }));
    await act(async () => socketEvents.handler!({ type: "draft", path: "app.js", text: "Ann's text", by: ann }));
    expect(container.querySelector('[data-testid="studio-live-typing"]')!.textContent).toContain("Ann is typing here");
    // The socket dropped and Ann left meanwhile. After hello the server sends again whatever is still being typed.
    await act(async () => socketEvents.handler!({ type: "hello", you: owner, participants: [owner] }));
    expect(container.querySelector('[data-testid="studio-live-typing"]')).toBeNull();
  });

  it("drops a chat that was cleared on another device once the transcript is read again", async () => {
    mockStudioApi.assistant.mockResolvedValue({ turns: [turn("u1", "user", 1), turn("a1", "assistant", 2)], running: false });
    await draw();
    await showSide("ai");
    expect(turnIds()).toEqual(["u1", "a1"]);
    mockStudioApi.assistant.mockResolvedValue({ turns: [], running: false });
    await reconnect();
    expect(turnIds()).toEqual([]);

    // A reply that came over the socket, then the chat is cleared there while the socket is down:
    // the server's answer is the same empty list as before, and the reply still goes.
    await act(async () => socketEvents.handler!({ type: "assistant", turn: turn("a5", "assistant", 5), done: true }));
    expect(turnIds()).toEqual(["a5"]);
    await wait(5);
    await reconnect();
    expect(turnIds()).toEqual([]);

    // Cleared there, and a new chat started there: the old turns go, the new ones show.
    mockStudioApi.assistant.mockResolvedValue({ turns: [turn("u1", "user", 1), turn("a1", "assistant", 2)], running: false });
    await reconnect();
    expect(turnIds()).toEqual(["u1", "a1"]);
    mockStudioApi.assistant.mockResolvedValue({ turns: [turn("u9", "user", 8)], running: false });
    await reconnect();
    expect(turnIds()).toEqual(["u9"]);
  });

  it("keeps a message that just went out when a transcript read before it answers", async () => {
    mockStudioApi.assistant.mockResolvedValue({ turns: [], running: false });
    await draw();
    await showSide("ai");
    // The transcript is being read again (the socket came back) when the first message goes out.
    let answer: (value: unknown) => void = () => undefined;
    mockStudioApi.assistant.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await reconnect();
    mockStudioApi.askAssistant.mockResolvedValue({ turn: turn("u1", "user", 1) });
    await act(async () => mockPanes.assistant!.onSend("Make it blue", "free", ""));
    expect(turnIds()).toEqual(["u1"]);
    await act(async () => answer({ turns: [], running: false }));
    await settle();
    expect(turnIds()).toEqual(["u1"]);

    // The same with a reply arriving over the socket while an older answer is on its way.
    mockStudioApi.assistant.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await reconnect();
    await act(async () => socketEvents.handler!({ type: "assistant", turn: turn("a1", "assistant", 2), done: true }));
    await act(async () => answer({ turns: [turn("u1", "user", 1)], running: false }));
    await settle();
    expect(turnIds()).toEqual(["u1", "a1"]);
  });

  // ── Saving ──────────────────────────────────────────────────────────────
  it("does not call the person's own save a change from somewhere else", async () => {
    const answers = heldSaves();
    await draw();
    await type("// a");
    await wait(900);
    expect(mockStudioApi.writeFile).toHaveBeenCalledTimes(1);
    // They type again while the save is on its way; the server's announcement of that save arrives first.
    await type("// ab");
    await act(async () => socketEvents.handler!({ type: "file:saved", path: "app.js", version: "v2", content: "// a", by: "Owner" }));
    expect(conflictShown()).toBe(false);
    await act(async () => answers[0]!("v2"));
    await settle();
    expect(conflictShown()).toBe(false);
    expect(saveState()).toBe("Edited");
    // The newest typing is saved on top of that save.
    await wait(900);
    expect(mockStudioApi.writeFile).toHaveBeenCalledTimes(2);
    expect(mockStudioApi.writeFile).toHaveBeenLastCalledWith("ws-1", { path: "app.js", content: "// ab", baseVersion: "v2" });
    // The same announcement after the answer, with more typing since: still theirs.
    await type("// abc");
    await act(async () => socketEvents.handler!({ type: "file:saved", path: "app.js", version: "v3", content: "// ab", by: "Owner" }));
    await act(async () => answers[1]!("v3"));
    await settle();
    expect(conflictShown()).toBe(false);
    expect(editor().value).toBe("// abc");
  });

  it("sends one save at a time, the next one with the version the first returned", async () => {
    const answers = heldSaves();
    await draw();
    await type("// a");
    await wait(900);
    // The first save is slow to answer; the person types again and the autosave comes round a second time.
    await type("// ab");
    await wait(900);
    expect(mockStudioApi.writeFile).toHaveBeenCalledTimes(1);
    await act(async () => answers[0]!("v2"));
    await settle();
    expect(mockStudioApi.writeFile).toHaveBeenCalledTimes(2);
    expect(mockStudioApi.writeFile).toHaveBeenLastCalledWith("ws-1", { path: "app.js", content: "// ab", baseVersion: "v2" });
    await act(async () => answers[1]!("v3"));
    await settle();
    expect(saveState()).toBe("Saved");
    expect(conflictShown()).toBe(false);

    // A late announcement of the first save changes nothing: the editor keeps the newer text.
    await act(async () => socketEvents.handler!({ type: "file:saved", path: "app.js", version: "v2", content: "// a", by: "Owner" }));
    expect(editor().value).toBe("// ab");
    expect(conflictShown()).toBe(false);
    // Someone else's save still shows as theirs.
    await act(async () => socketEvents.handler!({ type: "file:saved", path: "app.js", version: "v9", content: "// from Ann", by: "Ann" }));
    expect(editor().value).toBe("// from Ann");
    await type("// mine now");
    await act(async () => socketEvents.handler!({ type: "file:saved", path: "app.js", version: "v10", content: "// from Ann again", by: "Ann" }));
    expect(conflictShown()).toBe(true);
  });

  it("keeps someone's change that followed the person's own save when that save answers late", async () => {
    const answers = heldSaves();
    await draw();
    await type("// a");
    await wait(900);
    // On a slow link, before the save's answer: its announcement, then Ann's save on top of it.
    await act(async () => socketEvents.handler!({ type: "file:saved", path: "app.js", version: "v2", content: "// a", by: "Owner" }));
    await act(async () => socketEvents.handler!({ type: "file:saved", path: "app.js", version: "v3", content: "// from Ann", by: "Ann" }));
    expect(editor().value).toBe("// from Ann");
    await act(async () => answers[0]!("v2"));
    await settle();
    expect(editor().value).toBe("// from Ann");
    expect(saveState()).toBe("Saved");
    expect(conflictShown()).toBe(false);
    // The next edit is saved on top of Ann's version, not the older one the answer named.
    await type("// from Ann, and me");
    await wait(900);
    expect(mockStudioApi.writeFile).toHaveBeenLastCalledWith("ws-1", { path: "app.js", content: "// from Ann, and me", baseVersion: "v3" });
  });

  it("tries a failed save again by itself, and at once when the connection is back", async () => {
    const offline = new ApiError("Can't reach Automa right now.", 0, null);
    mockStudioApi.writeFile.mockRejectedValueOnce(offline).mockRejectedValueOnce(offline);
    await draw();
    await type("typed in a tunnel");
    await wait(900);
    expect(saveState()).toBe("Not saved");
    expect(mockStudioApi.writeFile).toHaveBeenCalledTimes(1);
    // Nobody touches anything: it is tried again after a pause. It fails once more.
    await wait(1700);
    expect(mockStudioApi.writeFile).toHaveBeenCalledTimes(2);
    expect(saveState()).toBe("Not saved");
    // The browser says it is online again: the save goes out without waiting for the next pause.
    await act(async () => window.dispatchEvent(new Event("online")));
    await settle();
    expect(mockStudioApi.writeFile).toHaveBeenCalledTimes(3);
    expect(mockStudioApi.writeFile).toHaveBeenLastCalledWith("ws-1", { path: "app.js", content: "typed in a tunnel", baseVersion: "v1" });
    expect(saveState()).toBe("Saved");
  });

  it("sends a failed save again as soon as the socket is back", async () => {
    mockStudioApi.writeFile.mockRejectedValueOnce(new ApiError("Can't reach Automa right now.", 0, null));
    await draw();
    await type("typed while the phone slept");
    await wait(900);
    expect(saveState()).toBe("Not saved");
    await reconnect();
    expect(mockStudioApi.writeFile).toHaveBeenCalledTimes(2);
    expect(saveState()).toBe("Saved");
  });

  it("leaves a save the server refused as a conflict for the person to settle, without trying again", async () => {
    mockStudioApi.writeFile.mockRejectedValue(new ApiError("This file changed since you opened it", 409, null));
    await draw();
    await type("mine");
    await wait(900);
    expect(conflictShown()).toBe(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    await wait(1700);
    expect(mockStudioApi.writeFile).toHaveBeenCalledTimes(1);
  });

  it("saves the last edit when the person leaves before the autosave", async () => {
    await draw();
    await type("typed just before the back arrow");
    await act(async () => root.unmount());
    expect(mockStudioApi.writeFile).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/studio/workspaces/ws-1/file");
    expect(init).toMatchObject({ method: "PUT", keepalive: true, credentials: "include" });
    expect(JSON.parse(String(init.body))).toEqual({ path: "app.js", content: "typed just before the back arrow", baseVersion: "v1" });
    // The same headers the API client sends.
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Paperclip-Tab-Visible")).not.toBeNull();
    expect(headers.get("X-Paperclip-Route")).toBe(window.location.pathname);
    root = createRoot(container);
  });

  it("saves the last edit when the page is closed or left for another, and nothing when there is nothing to save", async () => {
    await draw();
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(mockFetch).not.toHaveBeenCalled();
    await type("typed just before closing the tab");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![1]).toMatchObject({ method: "PUT", keepalive: true });
    // The page came back (the Back button): that save counts, and the autosave has nothing left to send.
    expect(saveState()).toBe("Saved");
    await wait(900);
    expect(mockStudioApi.writeFile).not.toHaveBeenCalled();
    // A file too large for a request that outlives the page still goes out, as a normal request.
    const large = "x".repeat(70_000);
    await type(large);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]![1]).toMatchObject({ method: "PUT", keepalive: false });
    expect(JSON.parse(String((mockFetch.mock.calls[1]![1] as RequestInit).body))).toEqual({ path: "app.js", content: large, baseVersion: "v-left" });
  });

  // ── Requests that fail ──────────────────────────────────────────────────
  it("says when a file could not be deleted, since its row comes back", async () => {
    mockStudioApi.deleteEntry.mockRejectedValue(new ApiError("Can't reach Automa right now.", 0, null));
    await draw();
    await act(async () => mockTree.remove!("other.js"));
    await settle();
    expect(mockStudioApi.deleteEntry).toHaveBeenCalledWith("ws-1", "other.js");
    expect(mockPushToast).toHaveBeenCalledWith({ title: "Couldn't delete other.js", body: "Can't reach Automa right now.", tone: "error" });
  });

  const openSettings = async () => {
    const more = container.querySelector<HTMLButtonElement>('[data-testid="studio-more"]')!;
    await act(async () => more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
    const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes("Settings and colors"))!;
    await act(async () => item.click());
    await settle();
    return document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  };
  const dialogButton = (dialog: HTMLElement, label: string) => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label)!;

  it("says when the settings could not be saved or the app could not be deleted", async () => {
    mockStudioApi.update.mockRejectedValue(new Error("Internal server error"));
    mockStudioApi.remove.mockRejectedValue(new Error("The app is still running"));
    await draw();
    const dialog = await openSettings();
    await act(async () => dialogButton(dialog, "Save").click());
    await settle();
    expect(mockStudioApi.update).toHaveBeenCalledWith("ws-1", { name: "Recipe box", runCommand: null });
    expect(mockPushToast).toHaveBeenCalledWith({ title: "Couldn't save the settings", body: "Internal server error", tone: "error" });

    await act(async () => dialogButton(dialog, "Delete app").click());
    await act(async () => dialogButton(dialog, "Tap again to delete this app and its files").click());
    await settle();
    expect(mockStudioApi.remove).toHaveBeenCalledWith("ws-1");
    expect(mockPushToast).toHaveBeenCalledWith({ title: "Couldn't delete the app", body: "The app is still running", tone: "error" });
    // The dialog is still open, so the person can try again.
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("puts focus back on the More button when the settings dialog closes", async () => {
    await draw();
    const dialog = await openSettings();
    await act(async () => dialogButton(dialog, "Cancel").click());
    await settle();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="studio-more"]'));
    // The Checkpoints sheet opens from the same menu, and is told the same button.
    expect(mockPanes.checkpoints!.returnFocusRef!.current).toBe(container.querySelector('[data-testid="studio-more"]'));
  });

  // ── Running ─────────────────────────────────────────────────────────────
  it("tells the preview while a run is starting, so its own Run button can wait", async () => {
    let started: (value: unknown) => void = () => undefined;
    mockStudioApi.run.mockImplementation(() => new Promise((resolve) => (started = resolve)));
    await draw();
    await showSide("preview");
    expect(mockPanes.preview!.starting).toBe(false);
    await act(async () => mockPanes.preview!.onRun!());
    await settle();
    expect(mockPanes.preview!.starting).toBe(true);
    await act(async () => started({ run: { status: "running", startedAt: "2026-10-01T00:00:00.000Z" } }));
    await settle();
    expect(mockPanes.preview!.starting).toBe(false);
    expect(mockStudioApi.run).toHaveBeenCalledTimes(1);
  });

  it("keeps showing a language install while Run is tapped", async () => {
    mockStudioApi.get.mockResolvedValue({
      workspace,
      run: null,
      assistantRunning: false,
      participants: [],
      toolchain: { languageId: "python", requires: "Python", available: false, installCommand: "pkg install python", note: null, platform: "termux" },
    });
    mockStudioApi.installToolchain.mockImplementation(() => new Promise(() => undefined));
    mockStudioApi.run.mockRejectedValue(new Error("python: not found"));
    await draw();
    const install = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Install")!;
    await act(async () => install.click());
    await settle();
    expect(container.querySelector('[data-testid="studio-toolchain-installing"]')).not.toBeNull();
    // Run, while the install is still going: the run fails and says so; the install is still shown.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="studio-run"]')!.click());
    await settle();
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't start the app", body: "python: not found" }));
    await showSide("console");
    expect(container.querySelector('[data-testid="studio-toolchain-installing"]')).not.toBeNull();
    expect(mockStudioApi.installToolchain).toHaveBeenCalledTimes(1);
  });

  // ── The AI pane ─────────────────────────────────────────────────────────
  it("tells the AI pane when the conversation has arrived, never before its turns", async () => {
    let answer: (value: unknown) => void = () => undefined;
    mockStudioApi.assistant.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await draw();
    await showSide("ai");
    expect(mockPanes.assistant!.turnsLoaded).toBe(false);
    await act(async () => answer({ turns: [turn("u1", "user", 1), turn("a1", "assistant", 2)], running: false }));
    await settle();
    expect(mockPanes.assistant!.turnsLoaded).toBe(true);
    // No draw said "arrived" while the turns were still missing: an empty chat is treated as a new one.
    expect(mockPanes.assistantDraws.filter((draw) => draw.turnsLoaded !== false && draw.turns === 0)).toEqual([]);
  });

  // ── The Team pane ───────────────────────────────────────────────────────
  describe("the invite link of a project that is already shared", () => {
    const shared = { ...workspace, shareEnabled: true, shareCode: "ABCD2345" };
    const link = {
      workspace: shared,
      code: "ABCD2345",
      inviteUrl: "https://invite.trycloudflare.com/studio-guest/?code=ABCD2345",
      localInviteUrl: "http://127.0.0.1:4100/studio-guest/?code=ABCD2345",
      publicError: null,
    };

    it("is asked for when the page is opened again, so the Team tab shows the link and not only the code", async () => {
      mockStudioApi.get.mockResolvedValue({ workspace: shared, run: null, assistantRunning: false, participants: [], toolchain: null });
      mockStudioApi.shareInfo.mockResolvedValue({ share: link });
      await draw();
      await showSide("team");
      expect(mockStudioApi.shareInfo).toHaveBeenCalledTimes(1);
      expect(mockStudioApi.shareInfo).toHaveBeenCalledWith("ws-1");
      expect(mockPanes.team).toMatchObject({ shareEnabled: true, shareCode: "ABCD2345", share: { inviteUrl: link.inviteUrl, localInviteUrl: link.localInviteUrl } });
    });

    it("is not asked for while the project is not shared", async () => {
      await draw();
      await showSide("team");
      expect(mockStudioApi.shareInfo).not.toHaveBeenCalled();
      expect(mockPanes.team!.share).toBeNull();
    });

    it("still shows the code when the link could not be read", async () => {
      mockStudioApi.get.mockResolvedValue({ workspace: shared, run: null, assistantRunning: false, participants: [], toolchain: null });
      mockStudioApi.shareInfo.mockRejectedValue(new Error("Failed to fetch"));
      await draw();
      await showSide("team");
      expect(mockPanes.team).toMatchObject({ shareEnabled: true, shareCode: "ABCD2345", share: null });
    });
  });
});
