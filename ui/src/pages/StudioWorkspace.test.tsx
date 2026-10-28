// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioFileNode } from "@paperclipai/shared";
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
  stop: vi.fn(),
  archiveUrl: vi.fn(() => "/archive.zip"),
  downloadUrl: vi.fn(() => "/download"),
  rawUrl: vi.fn(() => "/raw"),
}));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSocketSend = vi.hoisted(() => vi.fn());

vi.mock("../api/studio", () => ({ studioApi: mockStudioApi, studioSocketUrl: () => "ws://studio.test" }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => undefined }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast, dismissToast: () => undefined, clearToasts: () => undefined }) }));
vi.mock("../hooks/useStudioSocket", () => ({ useStudioSocket: () => ({ status: "open", send: mockSocketSend }) }));
vi.mock("../hooks/useNarrowScreen", () => ({ useNarrowScreen: () => false }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: "/studio/ws-1", search: "", hash: "", state: null }),
  useNavigate: () => () => undefined,
  useParams: () => ({ workspaceId: "ws-1" }),
}));
// The panes are tested on their own; here they only need to be there.
vi.mock("../components/studio/CodeEditor", () => ({
  CodeEditor: ({ path, value, onChange }: { path: string; value: string; onChange?: (value: string) => void }) => (
    <textarea aria-label="editor" data-path={path} value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));
vi.mock("../components/studio/StudioFileTree", () => ({
  StudioFileTree: ({ tree, onOpen }: { tree: StudioFileNode[]; onOpen: (path: string) => void }) => (
    <div>
      {tree.map((node) => (
        <button key={node.path} type="button" data-open={node.path} onClick={() => onOpen(node.path)}>
          {node.path}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../components/studio/StudioAssistant", () => ({ StudioAssistant: () => null }));
vi.mock("../components/studio/StudioTeamPanel", () => ({ StudioTeamPanel: () => null }));
vi.mock("../components/studio/StudioPreview", () => ({ StudioPreview: () => null }));
vi.mock("../components/studio/StudioConsole", () => ({ StudioConsole: () => null }));
vi.mock("../components/studio/StudioAssets", () => ({ StudioAssets: () => null }));
vi.mock("../components/studio/StudioCheckpointsSheet", () => ({ StudioCheckpointsSheet: () => null }));
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
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
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

  it("says when Stop fails instead of doing nothing", async () => {
    mockStudioApi.get.mockResolvedValue({ workspace, run: { status: "running", startedAt: "2026-10-01T00:00:00.000Z" }, assistantRunning: false, participants: [], toolchain: null });
    mockStudioApi.stop.mockRejectedValue(new Error("The app didn't answer"));
    await draw();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="studio-stop"]')!.click());
    await settle();
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't stop the app", body: "The app didn't answer", tone: "error" }));
  });
});
