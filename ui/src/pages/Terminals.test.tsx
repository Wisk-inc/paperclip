// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TERMINAL_TOOLS } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchModel, offeredModel, Terminals } from "./Terminals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const company = vi.hoisted(() => ({ id: null as string | null }));
const search = vi.hoisted(() => ({ value: new URLSearchParams() }));
const api = vi.hoisted(() => ({
  status: vi.fn(),
  sessions: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("@/api/terminals", () => ({ terminalsApi: api }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: company.id }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/lib/router", () => ({ useSearchParams: () => [search.value, vi.fn()] }));
vi.mock("@/components/terminals/TerminalView", () => ({ TerminalView: () => <div data-testid="terminal-view" /> }));
vi.mock("@/components/mascot/Mascot", () => ({ Mascot: () => null }));

const freechat = TERMINAL_TOOLS.find((tool) => tool.id === "freechat")!;
const claude = TERMINAL_TOOLS.find((tool) => tool.id === "claude")!;

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

function tools(installed: Record<string, boolean> = {}) {
  return TERMINAL_TOOLS.map((tool) => ({ id: tool.id, installed: installed[tool.id] ?? false }));
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Terminals />
      </QueryClientProvider>,
    ),
  );
}

function tile(id: string) {
  return host.querySelector<HTMLButtonElement>(`[data-testid=terminal-tool][data-tool=${id}]`)!;
}

beforeEach(() => {
  company.id = "company-1";
  search.value = new URLSearchParams();
  window.localStorage.clear();
  api.status.mockResolvedValue({ kind: "phone", linuxReady: true, relayReady: true, tools: tools({ claude: true }) });
  api.sessions.mockResolvedValue({ sessions: [] });
  api.start.mockResolvedValue({
    session: { id: "s1", companyId: "company-1", toolId: "claude", title: "Claude Code", cwd: "/", status: "running", exitCode: null, createdAt: "2026-11-02T00:00:00.000Z", agentId: null },
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
});

describe("Terminals page", () => {
  it("survives a cold load that renders before an organization is chosen", async () => {
    company.id = null;
    await render();
    company.id = "company-1";
    await render();
    await vi.waitFor(() => expect(host.querySelector("[data-testid=terminals-page]")).not.toBeNull());
  });

  it("looks again at what is installed when you come back from a terminal", async () => {
    await render();
    await vi.waitFor(() => expect(tile("claude")).toBeTruthy());
    expect(api.status).toHaveBeenCalledTimes(1);

    await act(async () => tile("claude").click());
    await vi.waitFor(() => expect(host.querySelector("[data-testid=terminal-view]")).not.toBeNull());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to terminals"]')!.click());

    await vi.waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
  });

  it("says Python is missing and keeps the tools from failing one by one", async () => {
    api.status.mockResolvedValue({ kind: "phone", linuxReady: true, relayReady: false, tools: tools({ claude: true }) });
    await render();

    await vi.waitFor(() => expect(host.querySelector("[data-testid=terminals-relay-missing]")?.textContent).toContain("pkg install python"));
    expect(tile("claude").disabled).toBe(true);
    expect(tile("shell").disabled).toBe(true);
  });

  it("opens an agent's tool with the agent's model from its link", async () => {
    search.value = new URLSearchParams({ tool: "claude", agent: "6f1c2c0e-7d55-4a60-9a8f-3f2f8b2d4c11", model: "claude-sonnet-4-6" });
    await render();

    await vi.waitFor(() => expect(api.start).toHaveBeenCalled());
    expect(api.start).toHaveBeenCalledWith("company-1", expect.objectContaining({
      toolId: "claude",
      mode: "run",
      agentId: "6f1c2c0e-7d55-4a60-9a8f-3f2f8b2d4c11",
      model: "claude-sonnet-4-6",
    }));
  });

  it("drops a model from the link that the server would refuse", async () => {
    search.value = new URLSearchParams({ tool: "claude", model: "bad model; rm -rf /" });
    await render();

    await vi.waitFor(() => expect(api.start).toHaveBeenCalled());
    expect(api.start.mock.calls[0]![1]).not.toHaveProperty("model");
  });
});

describe("terminal model choice", () => {
  it("ignores a saved model the tool no longer offers", () => {
    expect(offeredModel(claude, "a-model-from-an-old-release")).toBeUndefined();
    expect(offeredModel(claude, claude.models![0])).toBe(claude.models![0]);
  });

  it("opens the free models with the model the picker calls Default", () => {
    expect(launchModel(freechat, undefined)).toBe(freechat.models![0]);
    expect(launchModel(freechat, "gone-model")).toBe(freechat.models![0]);
    // Other tools keep their own default.
    expect(launchModel(claude, undefined)).toBeUndefined();
  });
});
