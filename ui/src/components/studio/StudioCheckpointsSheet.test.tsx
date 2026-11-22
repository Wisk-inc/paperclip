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
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("@/context/ToastContext", () => ({ useOptionalToastActions: () => ({ pushToast }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TWO_CHECKPOINTS = {
  checkpoints: [
    { id: "c2", label: "Before the AI changed things", kind: "assistant", by: "You", createdAt: "2026-10-01T10:00:00.000Z", fileCount: 3, bytes: 1000, skippedFiles: 0 },
    { id: "c1", label: "First version", kind: "manual", by: "You", createdAt: "2026-10-01T08:00:00.000Z", fileCount: 3, bytes: 900, skippedFiles: 0 },
  ],
};

/** The sheet as the workspace page holds it: always mounted, opened and closed with a prop. */
async function mountSheet() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const restoreButtons = () => [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="studio-restore-checkpoint"]')];
  /** Opens or closes the sheet; once open, waits for the two checkpoints to be listed. */
  const show = async (open: boolean) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <StudioCheckpointsSheet open={open} onOpenChange={vi.fn()} workspaceId="ws-1" onRestored={vi.fn()} />
        </QueryClientProvider>,
      ),
    );
    for (let turn = 0; turn < 20 && (open ? restoreButtons().length !== 2 : restoreButtons().length !== 0); turn += 1) await tick();
  };
  const alertText = () => document.body.querySelector('[data-testid="studio-checkpoints"] [role="alert"]')?.textContent ?? null;
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { show, tick, restoreButtons, alertText, unmount };
}

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

  it("does not show an old refusal again when the sheet is reopened", async () => {
    mockStudioApi.checkpoints.mockResolvedValue(TWO_CHECKPOINTS);
    mockStudioApi.restoreCheckpoint.mockReset();
    mockStudioApi.restoreCheckpoint.mockRejectedValue(new Error("Stop the assistant before going back to a checkpoint"));
    const sheet = await mountSheet();
    try {
      await sheet.show(true);
      await act(async () => sheet.restoreButtons()[0]!.click());
      await act(async () => sheet.restoreButtons()[0]!.click());
      await sheet.tick();
      expect(sheet.alertText()).toBe("Couldn't go back: Stop the assistant before going back to a checkpoint");

      await sheet.show(false);
      await sheet.show(true);
      expect(sheet.restoreButtons()).toHaveLength(2);
      expect(sheet.alertText()).toBeNull();
    } finally {
      await sheet.unmount();
    }
  });

  it("forgets a checkpoint armed with one tap when the sheet is closed, so one tap later never restores", async () => {
    mockStudioApi.checkpoints.mockResolvedValue(TWO_CHECKPOINTS);
    mockStudioApi.restoreCheckpoint.mockReset();
    mockStudioApi.restoreCheckpoint.mockResolvedValue({ restored: TWO_CHECKPOINTS.checkpoints[1] });
    const sheet = await mountSheet();
    try {
      await sheet.show(true);
      await act(async () => sheet.restoreButtons()[1]!.click());
      expect(sheet.restoreButtons()[1]!.textContent).toContain("Tap again to go back here");

      await sheet.show(false);
      await sheet.show(true);
      expect(sheet.restoreButtons()[1]!.textContent).toContain("Go back here");
      expect(sheet.restoreButtons()[1]!.textContent).not.toContain("Tap again");
      await act(async () => sheet.restoreButtons()[1]!.click());
      await sheet.tick();
      expect(mockStudioApi.restoreCheckpoint).not.toHaveBeenCalled();
      expect(sheet.restoreButtons()[1]!.textContent).toContain("Tap again to go back here");
    } finally {
      await sheet.unmount();
    }
  });

  it("says which files stayed as they are after going back, where it can still be read", async () => {
    mockStudioApi.checkpoints.mockResolvedValue(TWO_CHECKPOINTS);
    mockStudioApi.restoreCheckpoint.mockReset();
    pushToast.mockReset();
    const notice = "Left as it is, because it is too large for a checkpoint: video.mp4.";
    mockStudioApi.restoreCheckpoint.mockResolvedValueOnce({ restored: TWO_CHECKPOINTS.checkpoints[1], leftAsIs: ["video.mp4"], notice });
    const sheet = await mountSheet();
    try {
      await sheet.show(true);
      await act(async () => sheet.restoreButtons()[1]!.click());
      await act(async () => sheet.restoreButtons()[1]!.click());
      await sheet.tick();
      expect(pushToast).toHaveBeenCalledTimes(1);
      expect(pushToast.mock.calls[0]![0]).toMatchObject({ title: "Not everything went back", body: notice, tone: "warn" });

      // Nothing was left behind: nothing to say.
      pushToast.mockReset();
      mockStudioApi.restoreCheckpoint.mockResolvedValueOnce({ restored: TWO_CHECKPOINTS.checkpoints[0], leftAsIs: [], notice: null });
      await act(async () => sheet.restoreButtons()[0]!.click());
      await act(async () => sheet.restoreButtons()[0]!.click());
      await sheet.tick();
      expect(mockStudioApi.restoreCheckpoint).toHaveBeenCalledTimes(2);
      expect(pushToast).not.toHaveBeenCalled();
    } finally {
      await sheet.unmount();
    }
  });

  it("still shows a failure that arrived after the sheet was closed", async () => {
    mockStudioApi.checkpoints.mockResolvedValue(TWO_CHECKPOINTS);
    mockStudioApi.restoreCheckpoint.mockReset();
    let refuse: (error: Error) => void = () => undefined;
    mockStudioApi.restoreCheckpoint.mockReturnValue(new Promise((_resolve, reject) => (refuse = reject)));
    const sheet = await mountSheet();
    try {
      await sheet.show(true);
      await act(async () => sheet.restoreButtons()[0]!.click());
      await act(async () => sheet.restoreButtons()[0]!.click());
      expect(mockStudioApi.restoreCheckpoint).toHaveBeenCalledWith("ws-1", "c2");

      // Closed while the restore is still on its way; it is then refused.
      await sheet.show(false);
      await act(async () => refuse(new Error("Stop the assistant before going back to a checkpoint")));
      await sheet.tick();

      await sheet.show(true);
      expect(sheet.alertText()).toBe("Couldn't go back: Stop the assistant before going back to a checkpoint");
      // Read once: closing again clears it.
      await sheet.show(false);
      await sheet.show(true);
      expect(sheet.alertText()).toBeNull();
    } finally {
      await sheet.unmount();
    }
  });

  it("sends focus back to the control that opened it when it closes", async () => {
    mockStudioApi.checkpoints.mockResolvedValue(TWO_CHECKPOINTS);
    const opener = document.createElement("button");
    opener.textContent = "More";
    document.body.appendChild(opener);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const sheet = (open: boolean) => (
      <QueryClientProvider client={client}>
        <StudioCheckpointsSheet open={open} onOpenChange={vi.fn()} workspaceId="ws-1" onRestored={vi.fn()} returnFocusRef={{ current: opener }} />
      </QueryClientProvider>
    );
    try {
      await act(async () => root.render(sheet(true)));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(document.body.querySelector('[data-testid="studio-checkpoints"]')).not.toBeNull();
      expect(document.activeElement).not.toBe(opener);

      await act(async () => root.render(sheet(false)));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
      expect(document.body.querySelector('[data-testid="studio-checkpoints"]')).toBeNull();
      expect(document.activeElement).toBe(opener);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      opener.remove();
    }
  });
});
