// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioEditorStatus, createEditorCursorStore, type StudioSaveState } from "./StudioEditorStatus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StudioEditorStatus", () => {
  let container: HTMLDivElement;
  let root: Root;
  const store = createEditorCursorStore();
  const onToggleSuggest = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    store.set(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const draw = (props: { path?: string | null; saveState?: StudioSaveState; suggestOn?: boolean } = {}) =>
    act(async () =>
      root.render(
        <StudioEditorStatus
          path={props.path === undefined ? "src/app.js" : props.path}
          cursorStore={store}
          saveState={props.saveState ?? "saved"}
          suggestOn={props.suggestOn ?? true}
          onToggleSuggest={onToggleSuggest}
        />,
      ),
    );
  const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

  it("shows the cursor's line and column, and follows it", async () => {
    await draw();
    await act(async () => store.set({ line: 12, column: 5, selected: 0 }));
    expect(text("studio-cursor-position")).toBe("Ln 12, Col 5");
    expect(text("studio-cursor-selected")).toBeNull();

    await act(async () => store.set({ line: 3, column: 41, selected: 0 }));
    expect(text("studio-cursor-position")).toBe("Ln 3, Col 41");
  });

  it("says how much is selected while there is a selection", async () => {
    await draw();
    await act(async () => store.set({ line: 2, column: 1, selected: 18 }));
    expect(text("studio-cursor-position")).toBe("Ln 2, Col 1");
    expect(text("studio-cursor-selected")).toBe("(18 selected)");
    await act(async () => store.set({ line: 2, column: 1, selected: 0 }));
    expect(text("studio-cursor-selected")).toBeNull();
  });

  it("names the file's language and the indent", async () => {
    await draw({ path: "site/index.html" });
    await act(async () => store.set({ line: 1, column: 1, selected: 0 }));
    expect(text("studio-file-language")).toBe("HTML");
    expect(text("studio-indent")).toBe("Spaces: 2");

    await draw({ path: "main.py" });
    expect(text("studio-file-language")).toBe("Python");
  });

  it("shows no position with no editor open: a picture has a kind, and no file has nothing", async () => {
    await draw({ path: "logo.png" });
    expect(text("studio-cursor-position")).toBeNull();
    expect(text("studio-indent")).toBeNull();
    expect(text("studio-file-language")).toBe("Image");

    await draw({ path: null });
    expect(text("studio-file-language")).toBeNull();
    expect(text("studio-save-state")).toBe("");
  });

  it("says whether the file is saved", async () => {
    const shown: Record<StudioSaveState, string> = { saved: "Saved", dirty: "Edited", saving: "Saving…", error: "Not saved", conflict: "Changed elsewhere" };
    for (const [state, words] of Object.entries(shown) as Array<[StudioSaveState, string]>) {
      await draw({ saveState: state });
      expect(text("studio-save-state")).toBe(words);
    }
  });

  it("turns AI suggestions on and off", async () => {
    await draw({ suggestOn: true });
    const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="studio-suggest-toggle"]')!;
    expect(toggle().textContent).toBe("AI suggest");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    await act(async () => toggle().click());
    expect(onToggleSuggest).toHaveBeenCalledTimes(1);

    await draw({ suggestOn: false });
    expect(toggle().textContent).toBe("AI suggest off");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("redraws only when the cursor is somewhere new", () => {
    const fresh = createEditorCursorStore();
    const listener = vi.fn();
    const stop = fresh.subscribe(listener);
    fresh.set({ line: 1, column: 1, selected: 0 });
    fresh.set({ line: 1, column: 1, selected: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
    fresh.set({ line: 1, column: 2, selected: 0 });
    fresh.set(null);
    fresh.set(null);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(fresh.getSnapshot()).toBeNull();
    stop();
    fresh.set({ line: 4, column: 4, selected: 0 });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
