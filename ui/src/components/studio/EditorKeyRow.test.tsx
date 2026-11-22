// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { closeBrackets } from "@codemirror/autocomplete";
import { history, indentWithTab } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EDITOR_KEY_SYMBOLS, EditorKeyRow } from "./EditorKeyRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lays nothing out, and the editor measures its text after every change.
beforeAll(() => {
  const nowhere = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => nowhere;
});

describe("EditorKeyRow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let view: EditorView | null = null;
  const editorRef = createRef<EditorView | null>();

  /** An editor with the Studio editor's typing rules, holding `doc` with the cursor at `cursor`. */
  const edit = (doc: string, cursor: number, extra: Parameters<typeof EditorState.create>[0] = {}) => {
    close();
    view = new EditorView({
      parent: container,
      state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [history(), closeBrackets(), keymap.of([indentWithTab])], ...extra }),
    });
    editorRef.current = view;
  };
  const close = () => {
    view?.destroy();
    view = null;
    editorRef.current = null;
  };
  const key = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.dataset.key === name)!;
  const tap = async (name: string) => act(async () => key(name).click());
  const text = () => view!.state.doc.toString();
  const cursor = () => view!.state.selection.main.head;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<EditorKeyRow editorRef={editorRef} data-testid="keys" />));
  });

  afterEach(async () => {
    close();
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows Undo, Redo and Tab, then the symbols", () => {
    const keys = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="keys"] button')];
    expect(keys.slice(0, 3).map((item) => item.getAttribute("aria-label") ?? item.textContent)).toEqual(["Undo", "Redo", "Tab"]);
    expect(keys.slice(3).map((item) => item.textContent)).toEqual([...EDITOR_KEY_SYMBOLS]);
    for (const symbol of ["{", "}", "(", ")", "[", "]", "<", ">", "/", "=", ";", ":", '"', "'", ".", ","]) expect(EDITOR_KEY_SYMBOLS).toContain(symbol);
  });

  it("types a symbol at the cursor, not at the end", async () => {
    edit("let total = 1 + 2", 13);
    await tap(";");
    expect(text()).toBe("let total = 1; + 2");
    expect(cursor()).toBe(14);
    // A selection is replaced by the symbol.
    await act(async () => view!.dispatch({ selection: { anchor: 15, head: 16 } }));
    await tap("-");
    expect(text()).toBe("let total = 1; - 2");
  });

  it("types the way the keyboard does: an opening bracket brings its closing one, which is then stepped over", async () => {
    edit("go", 2);
    await tap("(");
    expect(text()).toBe("go()");
    expect(cursor()).toBe(3);
    await tap(")");
    expect(text()).toBe("go()");
    expect(cursor()).toBe(4);
  });

  it("indents with Tab, and undoes and redoes", async () => {
    edit("if (ready) {\nrun();\n}", 16);
    await tap("Tab");
    expect(text()).toBe("if (ready) {\n  run();\n}");
    await tap("Undo");
    expect(text()).toBe("if (ready) {\nrun();\n}");
    await tap("Redo");
    expect(text()).toBe("if (ready) {\n  run();\n}");
  });

  it("keeps the focus in the editor, so the keyboard stays open", () => {
    for (const item of container.querySelectorAll<HTMLButtonElement>("button")) {
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      item.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
    }
  });

  it("does nothing to text that can't be edited, or with no editor open", async () => {
    edit("read me", 0, { extensions: [EditorState.readOnly.of(true)] });
    await tap(";");
    await tap("Tab");
    expect(text()).toBe("read me");
    close();
    await tap(";");
  });
});
