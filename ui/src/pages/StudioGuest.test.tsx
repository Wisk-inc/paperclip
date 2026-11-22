// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMA_CREDIT } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { StudioGuest } from "./StudioGuest";

const mockGuestApi = vi.hoisted(() => ({
  workspace: vi.fn(),
  tree: vi.fn(),
  readFile: vi.fn(),
  console: vi.fn(),
  messages: vi.fn(),
  changes: vi.fn(),
  postMessage: vi.fn(),
  submitChange: vi.fn(),
  archiveUrl: vi.fn(() => "/archive.zip"),
  sharedFileUrl: vi.fn(() => "/shared"),
}));

/** The live socket, played by the test: it sets the status and delivers the server's events. */
const socket = vi.hoisted(() => {
  const state = {
    status: "open" as "connecting" | "open" | "closed",
    listeners: new Set<() => void>(),
    handler: null as ((event: unknown) => void) | null,
    sent: [] as unknown[],
    send: (event: unknown) => {
      state.sent.push(event);
    },
  };
  return state;
});

vi.mock("../api/studio", () => ({ studioGuestApi: mockGuestApi, studioSocketUrl: () => "ws://studio.test" }));
vi.mock("../hooks/useStudioSocket", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useStudioSocket: (_url: string | null, onEvent: (event: unknown) => void) => {
      socket.handler = onEvent;
      const status = useSyncExternalStore(
        (listener) => {
          socket.listeners.add(listener);
          return () => socket.listeners.delete(listener);
        },
        () => socket.status,
      );
      return { status, send: socket.send };
    },
  };
});
// The editor, the preview and the chat are stood in for by plain text, so the test reads what they were given.
vi.mock("../components/studio/CodeEditor", () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea data-testid="editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("../components/studio/StudioPreview", () => ({
  StudioPreview: ({ run }: { run: { status: string } | null }) => <div data-testid="preview">{run?.status ?? "not running"}</div>,
}));
vi.mock("../components/studio/StudioChat", () => ({
  StudioChat: ({ messages }: { messages: Array<{ id: string; body: string }> }) => (
    <ul data-testid="chat">
      {messages.map((message) => (
        <li key={message.id}>{message.body}</li>
      ))}
    </ul>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = { token: "tok", collaborator: { id: "c1", displayName: "Ann", color: "royalblue", status: "active" }, workspace: { id: "w1", name: "Shared app", language: "html" } };
const YOU = { id: "guest:c1", name: "Ann", color: "royalblue", role: "guest", online: true, activePath: null };
const OWNER = { id: "owner", name: "Owner", color: "crimson", role: "owner", online: true, activePath: null };
const IDLE = { status: "idle", command: null, pid: null, port: null, previewReady: false, previewPath: null, exitCode: null, startedAt: null, endedAt: null, publicUrl: null, tunnelStatus: "off", tunnelError: null };
const INDEX = { name: "index.html", path: "index.html", type: "file", size: 12 };

/** What the owner's server holds. A test changes it while the guest's socket is down. */
function serverState() {
  const state = {
    run: IDLE as Record<string, unknown>,
    messages: [] as Array<Record<string, unknown>>,
    tree: [INDEX] as Array<Record<string, unknown>>,
    files: { "index.html": "<h1>hi</h1>\n" } as Record<string, string>,
  };
  mockGuestApi.workspace.mockImplementation(async () => ({ workspace: SESSION.workspace, you: YOU, participants: [OWNER, YOU], run: state.run }));
  mockGuestApi.tree.mockImplementation(async () => ({ tree: state.tree }));
  mockGuestApi.console.mockImplementation(async () => ({ lines: [] }));
  mockGuestApi.messages.mockImplementation(async () => ({ messages: state.messages }));
  mockGuestApi.changes.mockImplementation(async () => ({ changeRequests: [] }));
  mockGuestApi.readFile.mockImplementation(async (_token: string, path: string) => {
    if (!(path in state.files)) throw new ApiError("File not found", 404, null);
    return { path, content: state.files[path], size: state.files[path]!.length, binary: false, version: `v${state.files[path]!.length}` };
  });
  return state;
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function setSocket(status: typeof socket.status) {
  socket.status = status;
  await act(async () => {
    for (const listener of socket.listeners) listener();
  });
  await settle();
}

async function serverSends(event: unknown) {
  await act(async () => socket.handler!(event));
  await settle();
}

/** The phone sleeps: the socket drops, and comes back after `whileAway` ran on the server. */
async function sleepAndWake(whileAway: () => void) {
  await setSocket("closed");
  await setSocket("connecting");
  whileAway();
  await setSocket("open");
  await serverSends({ type: "hello", you: YOU, participants: [OWNER, YOU] });
}

async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("StudioGuest", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    socket.status = "connecting";
    socket.listeners.clear();
    socket.handler = null;
    socket.sent.length = 0;
    window.localStorage.removeItem("automa.studio.guest");
    // Wide screen: the file tree, the editor and the side panel are all on screen at once.
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  /** A collaborator who already joined opens the page, and the socket connects. */
  async function openAsGuest() {
    window.localStorage.setItem("automa.studio.guest", JSON.stringify(SESSION));
    await act(async () => root.render(<StudioGuest />));
    await settle();
    await setSocket("open");
    await serverSends({ type: "hello", you: YOU, participants: [OWNER, YOU] });
  }

  const row = (path: string) => container.querySelector<HTMLButtonElement>(`[data-testid="studio-tree-${path}"]`);
  const editor = () => container.querySelector<HTMLTextAreaElement>('[data-testid="editor"]');
  const sideTab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Side panel"] [role="tab"]')].find((tab) => tab.textContent === label)!;

  it("wraps the footer credit between its parts on a phone, never inside one", async () => {
    await act(async () => root.render(<StudioGuest />));
    const footer = container.querySelector('[data-testid="studio-guest-credit"]')!;
    expect(footer.textContent).toBe(`Automa App Studio · ${AUTOMA_CREDIT}`);
    const credit = AUTOMA_CREDIT.split(" · ").map((part, index, parts) => (index < parts.length - 1 ? `${part} ·` : part));
    expect([...footer.querySelectorAll(".whitespace-nowrap")].map((part) => part.textContent)).toEqual(["Automa App Studio ·", ...credit]);
  });

  it("reads everything once when the page opens, not again when the socket first connects", async () => {
    serverState();
    await openAsGuest();
    for (const call of [mockGuestApi.workspace, mockGuestApi.tree, mockGuestApi.console, mockGuestApi.messages, mockGuestApi.changes]) {
      expect(call).toHaveBeenCalledTimes(1);
    }
    expect(row("index.html")).not.toBeNull();
  });

  it("reads the project again after a reconnect: the run, the chat, the files and the open file", async () => {
    const server = serverState();
    await openAsGuest();
    await act(async () => row("index.html")!.click());
    await settle();
    expect(editor()!.value).toBe("<h1>hi</h1>\n");

    await sleepAndWake(() => {
      // Meanwhile the owner runs the app, writes in the chat, adds a file and saves the open one.
      server.run = { ...IDLE, status: "running", previewReady: true };
      server.messages = [{ id: "m1", workspaceId: "w1", authorType: "owner", authorName: "Owner", collaboratorId: null, body: "It is running now, have a look!", attachment: null, createdAt: "2026-10-01T00:00:00.000Z" }];
      server.tree = [INDEX, { name: "new-page.html", path: "new-page.html", type: "file", size: 5 }];
      server.files["index.html"] = "<h1>changed while away</h1>\n";
    });

    for (const call of [mockGuestApi.workspace, mockGuestApi.tree, mockGuestApi.console, mockGuestApi.messages, mockGuestApi.changes]) {
      expect(call).toHaveBeenCalledTimes(2);
    }
    expect(row("new-page.html")).not.toBeNull();
    expect(container.querySelector('[data-testid="chat"]')!.textContent).toContain("It is running now, have a look!");
    expect(editor()!.value).toBe("<h1>changed while away</h1>\n");
    await act(async () => sideTab("Preview").click());
    expect(container.querySelector('[data-testid="preview"]')!.textContent).toBe("running");
  });

  it("keeps what you typed and did not send when the open file changed while you were away", async () => {
    const server = serverState();
    await openAsGuest();
    await act(async () => row("index.html")!.click());
    await settle();
    await typeInto(editor()!, "<h1>my idea</h1>\n");
    expect(container.querySelector('[data-testid="studio-guest-submit"]')!.textContent).toContain("Submit (1)");

    await sleepAndWake(() => {
      server.files["index.html"] = "<h1>changed while away</h1>\n";
    });

    // Your text is still in the editor and still waiting to be submitted.
    expect(editor()!.value).toBe("<h1>my idea</h1>\n");
    expect(container.querySelector('[data-testid="studio-guest-submit"]')!.textContent).toContain("Submit (1)");
    // Under it is the file as it is now, which is what Discard goes back to.
    const discard = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Discard my edits"))!;
    await act(async () => discard.click());
    expect(editor()!.value).toBe("<h1>changed while away</h1>\n");
  });

  it("stops showing the owner's typing from before the break once the saved file is read again", async () => {
    const server = serverState();
    await openAsGuest();
    await act(async () => row("index.html")!.click());
    await settle();
    await serverSends({ type: "draft", path: "index.html", text: "<h1>hi, half typ", by: OWNER });
    expect(editor()!.value).toBe("<h1>hi, half typ");

    await sleepAndWake(() => {
      // The owner finished and saved; the "stopped typing" note went out while this phone was asleep.
      server.files["index.html"] = "<h1>hi, half typed no more</h1>\n";
    });

    expect(editor()!.value).toBe("<h1>hi, half typed no more</h1>\n");
    expect(container.querySelector('[data-testid="studio-live-typing"]')).toBeNull();
  });

  it("ends the visit when the invite ran out while the phone was asleep", async () => {
    serverState();
    await openAsGuest();
    await sleepAndWake(() => {
      mockGuestApi.workspace.mockRejectedValue(new ApiError("Your invite ended or the code is wrong. Ask for a new code.", 401, null));
    });
    expect(container.textContent).toContain("You left the project");
    expect(container.textContent).toContain("Your invite ended. Ask the owner for a new code.");
  });

  it("makes a folder for your new files when you tap New folder", async () => {
    serverState();
    await openAsGuest();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="New folder"]')!.click());
    const nameBox = container.querySelector<HTMLInputElement>('[aria-label="New folder name"]')!;
    await typeInto(nameBox, "docs");
    await act(async () => nameBox.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();

    expect(container.querySelector('[aria-label="New folder name"]')).toBeNull();
    expect(row("docs")).not.toBeNull();
    expect(row("docs")!.getAttribute("aria-expanded")).toBe("false");
    // Nothing to send yet: a folder reaches the owner with the files put in it.
    expect(container.querySelector<HTMLButtonElement>('[data-testid="studio-guest-submit"]')!.disabled).toBe(true);

    // A new file inside it is part of your change.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="New file"]')!.click());
    const fileBox = container.querySelector<HTMLInputElement>('[aria-label="New file name"]')!;
    await typeInto(fileBox, "docs/readme.md");
    await act(async () => fileBox.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(container.querySelector('[data-testid="studio-guest-submit"]')!.textContent).toContain("Submit (1)");
    await act(async () => row("docs")!.click());
    expect(row("docs/readme.md")).not.toBeNull();
  });
});
