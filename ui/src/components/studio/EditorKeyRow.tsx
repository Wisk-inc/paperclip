import type { ComponentProps, RefObject } from "react";
import { redo, undo } from "@codemirror/commands";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { Redo2, Undo2 } from "lucide-react";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/** The symbols code needs most that a phone keyboard keeps a layer or two away. */
export const EDITOR_KEY_SYMBOLS = ["{", "}", "(", ")", "[", "]", "<", ">", "/", "=", ";", ":", '"', "'", ".", ",", "!", "-", "_", "+", "*", "&", "|", "#", "$", "\\", "`"] as const;

/**
 * Puts `text` in at the cursor the way the keyboard would: it goes through
 * the editor's own typing rules first, so an opening bracket or quote brings
 * its closing one, and a closing one that is already there is stepped over
 * instead of doubled.
 */
function typeText(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  const plain = () => view.state.update(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.type" });
  if (!view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, text, plain))) view.dispatch(plain());
}

/** The editor's own Tab key: takes a grey AI suggestion when one shows, otherwise indents. */
function pressTab(view: EditorView) {
  runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }), "editor");
}

interface EditorKeyRowProps extends Omit<ComponentProps<"div">, "children"> {
  /** The live editor (CodeEditor's `onReady`). */
  editorRef: RefObject<EditorView | null>;
  /** The symbol keys, in order. */
  symbols?: readonly string[];
}

/**
 * A row of keys for editing code on a phone: Undo, Redo, Tab, then the
 * symbols. A key acts at the cursor and leaves the keyboard open. The row
 * scrolls sideways.
 */
export function EditorKeyRow({ editorRef, symbols = EDITOR_KEY_SYMBOLS, className, ...props }: EditorKeyRowProps) {
  const press = (run: (view: EditorView) => void, focus = true) => {
    const view = editorRef.current;
    if (!view || view.state.readOnly) return;
    haptic("tick");
    run(view);
    if (focus) view.focus();
  };
  // A tap must not take the focus from the editor, or the keyboard closes.
  const keepFocus = { onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault() };
  const key = "flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md px-2 text-sm text-foreground hover:bg-accent active:bg-accent";
  return (
    <div
      role="toolbar"
      aria-label="Code keys"
      className={cn("flex shrink-0 scrollbar-none items-center gap-0.5 overflow-x-auto overscroll-x-contain border-t border-border bg-card px-1", className)}
      {...props}
    >
      <button type="button" aria-label="Undo" {...keepFocus} onClick={() => press((view) => undo(view), false)} className={key} data-key="Undo">
        <Undo2 className="size-4" aria-hidden="true" />
      </button>
      <button type="button" aria-label="Redo" {...keepFocus} onClick={() => press((view) => redo(view), false)} className={key} data-key="Redo">
        <Redo2 className="size-4" aria-hidden="true" />
      </button>
      <button type="button" {...keepFocus} onClick={() => press(pressTab)} className={key} data-key="Tab">
        Tab
      </button>
      {symbols.map((symbol) => (
        <button key={symbol} type="button" translate="no" {...keepFocus} onClick={() => press((view) => typeText(view, symbol))} className={cn(key, "font-mono")} data-key={symbol}>
          {symbol}
        </button>
      ))}
    </div>
  );
}
