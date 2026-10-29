// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { ChatWelcome } from "./ChatWelcome";

vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("./AgentChatHeader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AgentChatHeader")>()),
  EditAgentButton: () => null,
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", issuePrefix: "PAP" }, companies: [] }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agentWith = (status: string) =>
  ({ id: "a1", companyId: "c1", name: "James", role: "general", status, adapterType: "free_models", adapterConfig: {} }) as unknown as Agent;

describe("ChatWelcome status dot", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function dotFor(status: string) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ThemeProvider>
            <MemoryRouter>
              <ChatWelcome agent={agentWith(status)} />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    return container.querySelector('[data-slot="chat-welcome"] .border-4');
  }

  it("matches the chat header: amber while waiting for approval, no dot once removed", async () => {
    expect((await dotFor("pending_approval"))?.className).toContain("bg-amber-500");
    expect((await dotFor("idle"))?.className).toContain("bg-emerald-500");
    expect(await dotFor("terminated")).toBeNull();
  });
});
