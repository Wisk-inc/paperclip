// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import { ChatContextSheet } from "./ChatCommandSheets";

const byAgentModel = vi.hoisted(() => vi.fn());
vi.mock("@/api/costs", () => ({ costsApi: { byAgentModel } }));
vi.mock("@/api/issues", () => ({ issuesApi: { listComments: vi.fn(async () => []) } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agent = {
  id: "a1",
  companyId: "c1",
  name: "James",
  adapterType: "free_models",
  adapterConfig: { model: "deepseek/deepseek-chat" },
} as unknown as Agent;

const row = (agentId: string, costCents: number) => ({
  agentId,
  model: "deepseek/deepseek-chat",
  provider: "openrouter",
  costCents,
  inputTokens: 1200,
  cachedInputTokens: 0,
  outputTokens: 300,
});

describe("ChatContextSheet", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 28, 12, 0, 0));
    byAgentModel.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function renderSheet() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <ChatContextSheet open onOpenChange={() => undefined} agent={agent} issue={null} workMode="standard" messageCount={4} />
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    return document.querySelector('[data-testid="chat-context-sheet"]') as HTMLElement;
  }

  it("counts this month's spend, not every month's", async () => {
    byAgentModel.mockResolvedValue([row("a1", 250), row("other", 9900)]);
    const sheet = await renderSheet();
    expect(byAgentModel).toHaveBeenCalledWith("c1", new Date(2026, 9, 1).toISOString());
    expect(sheet.textContent).toContain("Spend this month$2.50");
  });

  it("says the usage could not load instead of showing $0.00", async () => {
    byAgentModel.mockRejectedValue(new Error("Network unreachable"));
    const sheet = await renderSheet();
    expect(sheet.textContent).toContain("Couldn’t load this month’s usage: Network unreachable");
    expect(sheet.textContent).not.toContain("$0.00");
  });
});
