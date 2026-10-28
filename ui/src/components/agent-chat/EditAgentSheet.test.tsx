// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { EditAgentSheet } from "./EditAgentSheet";

const update = vi.hoisted(() => vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...patch })));
vi.mock("@/api/agents", () => ({ agentsApi: { update, list: vi.fn(async () => []) } }));
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
});
