// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectorProjectView, InspectorStatusView } from "@/api/app-inspector";
import { ApiError } from "@/api/client";
import { AppInspector } from "./AppInspector";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  status: vi.fn(),
  projects: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  pushToast: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));
vi.mock("@/api/app-inspector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/app-inspector")>()),
  appInspectorApi: { status: api.status, projects: api.projects, upload: api.upload, remove: api.remove },
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: api.setBreadcrumbs }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: api.pushToast }) }));
vi.mock("@/hooks/useAskClaude", () => ({ useAskClaude: () => ({ agent: null, ready: false, ask: () => false }) }));
// The opened project is its own component with its own tests.
vi.mock("@/components/app-inspector/ProjectExplorer", () => ({
  ProjectExplorer: ({ projectId }: { projectId: string }) => <div data-testid="explorer" data-project={projectId} />,
}));

const COMPANY = "company-1";
const project: InspectorProjectView = {
  id: "project-1",
  label: "Notes",
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
const status = (overrides: Partial<InspectorStatusView> = {}): InspectorStatusView => ({ kind: "computer", apktoolReady: true, jadxReady: true, apps: [], ...overrides });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.status.mockResolvedValue(status());
  api.projects.mockResolvedValue({ projects: [project] });
  api.upload.mockResolvedValue({ project: { ...project, id: "project-2", status: "decoding", decoded: false, java: "working" } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.restoreAllMocks();
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
        <AppInspector />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.body.querySelector<T>(`[data-testid="${id}"]`);

async function chooseApk(name: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], name, { type: "application/vnd.android.package-archive" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  return file;
}

describe("AppInspector: choosing an APK file", () => {
  it("decodes it with the app sheet's own choices: resources, smali and Java", async () => {
    await draw();
    const file = await chooseApk("notes.apk");
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.upload).toHaveBeenCalledWith(COMPANY, file, { label: "notes", options: { resources: true, sources: true, java: true } });
    // The new project opens.
    expect(byId("explorer")!.getAttribute("data-project")).toBe("project-2");
  });

  it("leaves Java off on a computer without jadx, so the decode does not fail on it", async () => {
    api.status.mockResolvedValue(status({ jadxReady: false }));
    await draw();
    const file = await chooseApk("Notes.APK");
    expect(api.upload).toHaveBeenCalledWith(COMPANY, file, { label: "Notes", options: { resources: true, sources: true, java: false } });
  });
});

describe("AppInspector: deleting a project", () => {
  it("says why when the delete failed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.remove.mockRejectedValue(new ApiError("Still working; wait for it to finish.", 422, { error: "Still working; wait for it to finish." }));
    await draw();
    await act(async () => byId("inspector-tab-projects")!.click());
    await settle();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Delete Notes"]')!.click());
    await settle();

    expect(api.remove).toHaveBeenCalledWith(COMPANY, "project-1");
    expect(api.pushToast).toHaveBeenCalledTimes(1);
    expect(api.pushToast).toHaveBeenCalledWith({ title: "Couldn't delete that project", body: "Still working; wait for it to finish.", tone: "error" });
    // The project is still listed.
    expect(byId("inspector-project")!.textContent).toContain("Notes");
  });

  it("drops it from the list when the delete worked, without a toast", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.remove.mockResolvedValue({ ok: true });
    await draw();
    await act(async () => byId("inspector-tab-projects")!.click());
    await settle();
    api.projects.mockResolvedValue({ projects: [] });
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Delete Notes"]')!.click());
    await settle();
    expect(byId("inspector-project")).toBeNull();
    expect(byId("inspector-no-projects")).not.toBeNull();
    expect(api.pushToast).not.toHaveBeenCalled();
  });
});
