// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { AgentAiSettings } from "./AgentAiSettings";

const update = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/api/agents", () => ({ agentsApi: { update } }));
vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
  useOptionalToastActions: () => ({ pushToast: vi.fn() }),
}));
vi.mock("./ModelPickerSheet", () => ({ ModelPickerSheet: () => null }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", issuePrefix: "PAP" }, companies: [] }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agent = {
  id: "a1",
  companyId: "c1",
  name: "James",
  adapterType: "claude_local",
  adapterConfig: { model: "claude-opus-5-5" },
} as unknown as Agent;

describe("AgentAiSettings", () => {
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

  it("shows the model and thinking modes, and switches a Claude agent to the API", async () => {
    const client = new QueryClient();
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <MemoryRouter>
              <AgentAiSettings agent={agent} onNavigate={() => undefined} />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    expect(container.querySelector('[data-testid="agent-ai-model"]')?.textContent).toContain("Claude Opus 5.5");
    expect(container.querySelector('[data-testid="thinking-depth"]')).not.toBeNull();
    const apiOption = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Anthropic API"))!;
    expect(apiOption.getAttribute("aria-pressed")).toBe("false");
    await act(async () => apiOption.click());
    expect(update).toHaveBeenCalledWith("a1", { adapterConfig: { engine: "api" } }, "c1");
  });
});
