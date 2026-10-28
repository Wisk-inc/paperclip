// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { StudioCheckpointsSheet } from "./StudioCheckpointsSheet";

const mockStudioApi = vi.hoisted(() => ({
  checkpoints: vi.fn(),
  saveCheckpoint: vi.fn(),
  restoreCheckpoint: vi.fn(),
  deleteCheckpoint: vi.fn(),
}));
vi.mock("@/api/studio", () => ({ studioApi: mockStudioApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StudioCheckpointsSheet", () => {
  it("says when a checkpoint didn't save, so nobody counts on one that isn't there", async () => {
    mockStudioApi.checkpoints.mockResolvedValue({ checkpoints: [] });
    mockStudioApi.saveCheckpoint.mockRejectedValue(new Error("The phone is out of space"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <StudioCheckpointsSheet open onOpenChange={vi.fn()} workspaceId="ws-1" onRestored={vi.fn()} />
          </QueryClientProvider>,
        ),
      );
      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="studio-save-checkpoint"]')!.click());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(document.body.querySelector('[data-testid="studio-checkpoints"] [role="alert"]')?.textContent).toBe("Couldn't save the checkpoint: The phone is out of space");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
