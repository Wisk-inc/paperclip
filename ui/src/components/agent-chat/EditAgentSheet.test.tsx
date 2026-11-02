// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import { useQuery } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { agentRouteRef } from "@/lib/utils";
import { EditAgentSheet } from "./EditAgentSheet";

const update = vi.hoisted(() => vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...patch })));
const list = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
vi.mock("@/api/agents", () => ({ agentsApi: { update, list } }));
vi.mock("@/adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({ supportsInstructionsBundle: false }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
  useOptionalToastActions: () => ({ pushToast: vi.fn() }),
}));
vi.mock("./AgentAiSettings", () => ({ AgentAiSettings: () => null }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", issuePrefix: "PAP" }, companies: [] }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agent = {
  id: "a1",
  companyId: "c1",
  name: "James",
  urlKey: "james",
  role: "general",
  title: null,
  reportsTo: null,
  capabilities: null,
  adapterType: "free_models",
  adapterConfig: {},
} as unknown as Agent;

function footerButtons() {
  const sheet = document.querySelector('[data-testid="edit-agent-sheet"]')!;
  return [...sheet.querySelectorAll("form > div:last-child button")].map((button) => button.textContent?.trim());
}

describe("EditAgentSheet", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    update.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps Save on the AI tab while a rename is unsaved, so Done never drops it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <MemoryRouter>
              <EditAgentSheet agent={agent} open onOpenChange={() => undefined} initialTab="ai" />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    expect(footerButtons()).toContain("Done");

    await act(async () => (document.querySelector('[data-tab="profile"]') as HTMLButtonElement).click());
    const nameInput = document.querySelector('input[placeholder="Agent name"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(nameInput, "Jamie");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (document.querySelector('[data-tab="ai"]') as HTMLButtonElement).click());

    expect(footerButtons()).not.toContain("Done");
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save")!;
    await act(async () => save.click());
    expect(update).toHaveBeenCalledWith("a1", expect.objectContaining({ name: "Jamie" }), "c1");
  });

  it("moves an open chat off the old name's address before the agent list reloads, without a flash", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.agents.list("c1"), [agent]);
    update.mockImplementationOnce(async (_id: string, patch: Record<string, unknown>) => ({ ...agent, ...patch, urlKey: "jamie" }));
    // The reload stays pending, so the test sees the screen while it is in flight.
    let finishReload: (rows: unknown[]) => void = () => undefined;
    list.mockImplementation(() => new Promise<unknown[]>((resolve) => { finishReload = resolve; }));
    const seen: Array<{ path: string; found: boolean }> = [];
    function ChatProbe() {
      const location = useLocation();
      const agents = useQuery({ queryKey: queryKeys.agents.list("c1"), queryFn: () => list() as Promise<Agent[]> });
      const ref = location.pathname.split("/chats/")[1] ?? "";
      // The same lookup as the chat page: by id or by the named address.
      seen.push({ path: location.pathname, found: Boolean(agents.data?.some((item) => item.id === ref || agentRouteRef(item) === ref)) });
      return null;
    }
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <MemoryRouter initialEntries={["/PAP/chats/james"]}>
              <ChatProbe />
              <EditAgentSheet agent={agent} open onOpenChange={() => undefined} initialTab="profile" />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    const nameInput = document.querySelector('input[placeholder="Agent name"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(nameInput, "Jamie");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save")!;
    await act(async () => save.click());

    // Still reloading, yet the chat already moved off the old name's address.
    expect(seen.at(-1)!.path).toBe("/PAP/chats/a1");
    await act(async () => finishReload([{ ...agent, name: "Jamie", urlKey: "jamie" }]));
    // Before, during and after the reload the address always found the agent.
    expect(seen.at(-1)!).toEqual({ path: "/PAP/chats/a1", found: true });
    expect(seen.every((entry) => entry.found)).toBe(true);
  });
});
