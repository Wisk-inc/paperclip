// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { MemoryRouter } from "@/lib/router";
import { AgentTerminalSheet } from "./AgentTerminalSheet";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { list } }));
vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), isInitialHydrating: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agent = { id: "a1", companyId: "c1", name: "James", adapterType: "free_models", adapterConfig: {} } as unknown as Agent;

describe("AgentTerminalSheet", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    list.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says the runs could not load instead of claiming there are none", async () => {
    list.mockRejectedValue(new Error("Server unreachable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <AgentTerminalSheet agent={agent} open onOpenChange={() => undefined} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const terminal = document.querySelector('[data-testid="agent-terminal"]')!;
    expect(terminal.textContent).toContain("Couldn’t load James's runs: Server unreachable");
    expect(terminal.textContent).not.toContain("No runs yet");
  });
});
