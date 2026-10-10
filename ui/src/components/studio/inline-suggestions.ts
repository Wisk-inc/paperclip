import { closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from "@codemirror/view";

/** Asks for the text to insert at the cursor ("" for none). */
export type SuggestFn = (input: { prefix: string; suffix: string }, signal: AbortSignal) => Promise<string>;

interface Suggestion {
  pos: number;
  text: string;
}

const setSuggestion = StateEffect.define<Suggestion | null>();

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setSuggestion)) return effect.value;
    if (!value) return null;
    if (tr.docChanged) {
      // Typing the suggested characters keeps the rest of the suggestion.
      let kept: Suggestion | null = null;
      let changes = 0;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes += 1;
        const typed = inserted.toString();
        if (fromA === value.pos && toA === fromA && typed && value.text.startsWith(typed)) {
          kept = { pos: value.pos + typed.length, text: value.text.slice(typed.length) };
        }
      });
      const next = changes === 1 ? (kept as Suggestion | null) : null;
      return next && next.text ? next : null;
    }
    if (tr.selection && tr.state.selection.main.head !== value.pos) return null;
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) =>
      value ? Decoration.set([Decoration.widget({ widget: new GhostText(value.text), side: 1 }).range(value.pos)]) : Decoration.none,
    ),
});

class GhostText extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostText) {
    return other.text === this.text;
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    span.textContent = this.text;
    span.title = "Tap or press Tab to accept";
    span.setAttribute("aria-hidden", "true");
    // Phones have no Tab key: tapping the grey text accepts it.
    span.addEventListener("mousedown", (event) => {
      event.preventDefault();
      accept(view);
    });
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

function accept(view: EditorView): boolean {
  const value = view.state.field(suggestionField, false);
  if (!value) return false;
  view.dispatch({
    changes: { from: value.pos, insert: value.text },
    selection: { anchor: value.pos + value.text.length },
    effects: setSuggestion.of(null),
    userEvent: "input.complete",
  });
  return true;
}

function dismiss(view: EditorView): boolean {
  if (!view.state.field(suggestionField, false)) return false;
  view.dispatch({ effects: setSuggestion.of(null) });
  return true;
}

/** True when the cursor sits where a suggestion makes sense (end of a line, or before closing brackets). */
function goodSpot(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  const after = line.text.slice(range.head - line.from);
  const before = line.text.slice(0, range.head - line.from);
  if (!/^[\s)\]}"'`;,>]*$/.test(after)) return false;
  // Something to go on: this line or the one above has text.
  if (before.trim()) return true;
  const previous = line.number > 1 ? state.doc.line(line.number - 1).text : "";
  return Boolean(previous.trim());
}

/**
 * Grey "ghost" suggestions from the AI as you type: they appear after a short
 * pause, Tab accepts, Escape dismisses, and typing the same characters keeps
 * the rest. While one shows, the editor's word list is closed so there is only
 * one suggestion to accept. `suggest` is called with the text around the cursor.
 */
export function inlineSuggestions(suggest: SuggestFn, delayMs = 650): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      controller: AbortController | null = null;
      constructor(readonly view: EditorView) {}
      update(update: ViewUpdate) {
        // One suggestion at a time: while the grey text shows, the word list stays closed.
        if (update.state.field(suggestionField, false) && completionStatus(update.state)) {
          queueMicrotask(() => closeCompletion(this.view));
        }
        const typed = update.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete") || tr.isUserEvent("input.paste"));
        if (!typed && !(update.selectionSet && !update.docChanged)) return;
        this.cancel();
        if (!typed) return;
        if (update.state.field(suggestionField, false)) return;
        this.timer = setTimeout(() => void this.request(), delayMs);
      }
      cancel() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.controller?.abort();
        this.controller = null;
      }
      async request() {
        const view = this.view;
        if (!view.hasFocus || !goodSpot(view)) return;
        const head = view.state.selection.main.head;
        const doc = view.state.doc;
        const controller = new AbortController();
        this.controller = controller;
        try {
          const text = await suggest(
            { prefix: doc.sliceString(Math.max(0, head - 6000), head), suffix: doc.sliceString(head, Math.min(doc.length, head + 2000)) },
            controller.signal,
          );
          if (controller.signal.aborted || !text.trim()) return;
          if (view.state.doc !== doc || view.state.selection.main.head !== head) return;
          view.dispatch({ effects: setSuggestion.of({ pos: head, text }) });
        } catch {
          // No suggestion this time (offline, no key, or the request was cancelled).
        } finally {
          if (this.controller === controller) this.controller = null;
        }
      }
      destroy() {
        this.cancel();
      }
    },
  );
  return [
    suggestionField,
    plugin,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: accept },
        { key: "Escape", run: dismiss },
      ]),
    ),
    EditorView.domEventHandlers({ blur: (_event, view) => void dismiss(view) }),
    EditorView.theme({
      ".cm-ghost-text": { color: "var(--muted-foreground)", opacity: "0.75", fontStyle: "italic", whiteSpace: "pre", cursor: "pointer" },
    }),
  ];
}
