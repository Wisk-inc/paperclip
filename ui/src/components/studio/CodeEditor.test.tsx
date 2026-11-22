// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditor, type EditorCursor } from "./CodeEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lays nothing out, and the editor measures its text after every change.
beforeAll(() => {
  const nowhere = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => nowhere;
});

describe("CodeEditor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("says where the cursor is when it opens, when it moves, and when the text changes", async () => {
    const onCursor = vi.fn<(position: EditorCursor) => void>();
    const onChange = vi.fn();
    let view: EditorView | null = null;
    await act(async () =>
      root.render(<CodeEditor path="notes.txt" value={"first\nsecond line\nthird"} onChange={onChange} onCursor={onCursor} onReady={(editor) => (view = editor)} />),
    );
    const editor = view as unknown as EditorView;
    expect(onCursor).toHaveBeenCalledTimes(1);
    expect(onCursor).toHaveBeenLastCalledWith({ line: 1, column: 1, selected: 0 });

    // The cursor after "second": line 2, the 7th place on it.
    await act(async () => editor.dispatch({ selection: { anchor: 12 } }));
    expect(onCursor).toHaveBeenLastCalledWith({ line: 2, column: 7, selected: 0 });

    // "second line" selected from its end back to its start: the cursor is at the start.
    await act(async () => editor.dispatch({ selection: { anchor: 17, head: 6 } }));
    expect(onCursor).toHaveBeenLastCalledWith({ line: 2, column: 1, selected: 11 });

    // Typing moves the cursor along.
    await act(async () => editor.dispatch({ changes: { from: 6, to: 17, insert: "2nd" }, selection: { anchor: 9 } }));
    expect(onCursor).toHaveBeenLastCalledWith({ line: 2, column: 4, selected: 0 });
    expect(onChange).toHaveBeenLastCalledWith("first\n2nd\nthird");

    // Something that changes neither the text nor the selection is not reported.
    const calls = onCursor.mock.calls.length;
    await act(async () => editor.dispatch({}));
    expect(onCursor).toHaveBeenCalledTimes(calls);
  });

  it("reports the cursor after the text is replaced from outside, without calling that typing", async () => {
    const onCursor = vi.fn<(position: EditorCursor) => void>();
    const onChange = vi.fn();
    let view: EditorView | null = null;
    const draw = (value: string) =>
      act(async () => root.render(<CodeEditor path="notes.txt" value={value} onChange={onChange} onCursor={onCursor} onReady={(editor) => (view = editor)} />));
    await draw("one\ntwo\nthree");
    await act(async () => (view as unknown as EditorView).dispatch({ selection: { anchor: 13 } }));
    expect(onCursor).toHaveBeenLastCalledWith({ line: 3, column: 6, selected: 0 });

    // Someone else's save made the file shorter: the cursor is kept inside it.
    await draw("one");
    expect(onCursor).toHaveBeenLastCalledWith({ line: 1, column: 4, selected: 0 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
