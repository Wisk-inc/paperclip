// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentChatEnabled } from "./useAgentChatEnabled";

const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let captured: ReturnType<typeof useAgentChatEnabled> | null = null;
function Harness() {
  captured = useAgentChatEnabled();
  return null;
}

let root: Root;
let container: HTMLDivElement;

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
  });
  await settle();
}

describe("useAgentChatEnabled", () => {
  beforeEach(() => {
    captured = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockInstanceSettingsApi.getExperimental.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("is on only when the server says so", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableAgentChat: true });
    await render();
    expect(captured).toMatchObject({ enabled: true, loaded: true, failed: false });
  });

  it("is off, not failed, when the server says off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableAgentChat: false });
    await render();
    expect(captured).toMatchObject({ enabled: false, loaded: true, failed: false, errorMessage: null });
  });

  it("reports a failed request as failed (with Try again), not as off", async () => {
    mockInstanceSettingsApi.getExperimental.mockRejectedValueOnce(new Error("Network unreachable"));
    await render();
    expect(captured).toMatchObject({ enabled: false, loaded: true, failed: true, errorMessage: "Network unreachable" });

    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableAgentChat: true });
    await act(async () => captured!.retry());
    await settle();
    expect(captured).toMatchObject({ enabled: true, failed: false });
  });
});
