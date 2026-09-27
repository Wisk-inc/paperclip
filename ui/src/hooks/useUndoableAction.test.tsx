// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastState } from "../context/ToastContext";
import { UNDO_WINDOW_MS, useUndoableAction } from "./useUndoableAction";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Api = ReturnType<typeof useUndoableAction>;

describe("useUndoableAction", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function mount(commit: (id: string) => Promise<unknown>) {
    const state: { api: Api | null; toasts: ReturnType<typeof useToastState> } = { api: null, toasts: [] };
    function Probe() {
      state.api = useUndoableAction({ commit });
      state.toasts = useToastState();
      return null;
    }
    const root = createRoot(container);
    act(() =>
      root.render(
        <ToastProvider>
          <Probe />
        </ToastProvider>,
      ),
    );
    return { state, root };
  }

  it("hides at once, offers Undo, and commits only after the window closes", async () => {
    const commit = vi.fn(() => Promise.resolve());
    const { state, root } = mount(commit);

    act(() => state.api!.run("file-1", "Deleted report.pdf"));
    expect(state.api!.hiddenIds.has("file-1")).toBe(true);
    expect(state.toasts[0]?.title).toBe("Deleted report.pdf");
    expect(state.toasts[0]?.action?.label).toBe("Undo");
    expect(commit).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(commit).toHaveBeenCalledWith("file-1");
    act(() => root.unmount());
  });

  it("Undo brings the item back and never calls the server", async () => {
    const commit = vi.fn(() => Promise.resolve());
    const { state, root } = mount(commit);

    act(() => state.api!.run("device-1", "Removed Pixel 8"));
    act(() => state.toasts[0]!.action!.onClick!());
    expect(state.api!.hiddenIds.has("device-1")).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    });
    expect(commit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("brings the item back when the server call fails", async () => {
    const commit = vi.fn(() => Promise.reject(new Error("offline")));
    const { state, root } = mount(commit);

    act(() => state.api!.run("request-1", "Declined"));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(state.api!.hiddenIds.has("request-1")).toBe(false);
    act(() => root.unmount());
  });

  it("commits whatever is still waiting when the page unmounts", () => {
    const commit = vi.fn(() => Promise.resolve());
    const { state, root } = mount(commit);

    act(() => state.api!.run("file-2", "Deleted notes.txt"));
    act(() => root.unmount());
    expect(commit).toHaveBeenCalledWith("file-2");
  });
});
