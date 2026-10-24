import { useEffect, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { studioEditorLanguageForPath } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { inlineSuggestions, type SuggestFn } from "./inline-suggestions";
import { smaliLanguageDescription } from "./smali-language";

interface CodeEditorProps {
  /** The file's path; picks the syntax highlighting. */
  path: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** Keyboard shortcut for save (Ctrl/Cmd+S). */
  onSave?: () => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  /** Grey AI suggestions while typing (off when absent). */
  suggest?: SuggestFn | null;
  /** The live editor, for callers that add their own controls (a key bar, Find). */
  onReady?: (view: EditorView | null) => void;
}

/** Editor chrome in token colors, so it follows light and dark mode. */
const studioEditorTheme = EditorView.theme({
  "&": { color: "var(--foreground)", backgroundColor: "var(--studio-editor-bg)", height: "100%" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": { backgroundColor: "var(--studio-editor-bg)", color: "var(--studio-editor-gutter)", borderRight: "var(--sz-1px) solid var(--border)" },
  ".cm-activeLine": { backgroundColor: "var(--studio-editor-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--studio-editor-active-line)", color: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--studio-editor-selection)",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--studio-editor-selection)", color: "inherit" },
  ".cm-selectionMatch": { backgroundColor: "var(--studio-editor-active-line)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--muted)", color: "var(--muted-foreground)", border: "none" },
  ".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)" },
  ".cm-panels-bottom": { borderTop: "var(--sz-1px) solid var(--border)" },
  // Find and replace, in the app's own field and button styles.
  ".cm-panel.cm-search": { padding: "var(--sz-7px) var(--sz-36px) var(--sz-7px) var(--sz-7px)", fontSize: "var(--text-sm)" },
  ".cm-panel.cm-search label": { fontSize: "var(--text-xs)", color: "var(--muted-foreground)" },
  ".cm-textfield": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "var(--sz-1px) solid var(--border)",
    borderRadius: "var(--radius-md)",
    padding: "var(--sz-4px) var(--sz-7px)",
    fontSize: "var(--text-sm)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
    border: "var(--sz-1px) solid var(--border)",
    borderRadius: "var(--radius-md)",
    padding: "var(--sz-4px) var(--sz-11px)",
    fontSize: "var(--text-xs)",
  },
  ".cm-button:active": { backgroundColor: "var(--accent)" },
  ".cm-panel.cm-search [name=close]": { color: "var(--muted-foreground)", fontSize: "var(--text-lg)" },
  ".cm-searchMatch": { backgroundColor: "var(--studio-editor-selection)" },
  ".cm-searchMatch-selected": { outline: "var(--sz-1px) solid var(--primary)" },
  ".cm-tooltip": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)", border: "var(--sz-1px) solid var(--border)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-foreground)" },
});

function languageFor(path: string): LanguageDescription | null {
  if (path.toLowerCase().endsWith(".smali")) return smaliLanguageDescription;
  const name = studioEditorLanguageForPath(path);
  return (name ? LanguageDescription.matchLanguageName(languages, name, false) : null) ?? LanguageDescription.matchFilename(languages, path.split("/").pop() ?? path);
}

/**
 * The Studio code editor (CodeMirror 6): line numbers, syntax colors for the
 * file's language (loaded on demand), brackets, search, undo history, and
 * soft-wrapped lines so code reads on a phone. Colors come from the
 * `--studio-syntax-*` tokens.
 */
export function CodeEditor({ path, value, onChange, readOnly = false, onSave, placeholder, className, ariaLabel, suggest = null, onReady }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageSlot = useRef(new Compartment());
  const readOnlySlot = useRef(new Compartment());
  const suggestSlot = useRef(new Compartment());
  // The editor keeps one suggestion extension; it calls whatever function is current.
  const suggestRef = useRef<SuggestFn | null>(suggest);
  suggestRef.current = suggest;
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onReadyRef = useRef(onReady);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onReadyRef.current = onReady;
  // Set while this component replaces the document itself, so that change is
  // not reported back as typing.
  const applyingRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(classHighlighter),
          studioEditorTheme,
          EditorView.lineWrapping,
          EditorState.tabSize.of(2),
          placeholder ? placeholderExtension(placeholder) : [],
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          languageSlot.current.of([]),
          suggestSlot.current.of(suggest && !readOnly ? inlineSuggestions((input, signal) => suggestRef.current?.(input, signal) ?? Promise.resolve("")) : []),
          readOnlySlot.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.contentAttributes.of({ "aria-label": ariaLabel ?? `Code editor: ${path}`, autocapitalize: "off", autocorrect: "off", spellcheck: "false" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingRef.current) onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    onReadyRef.current?.(view);
    return () => {
      onReadyRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // The editor is created once per file; value changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Syntax colors for this file's language, loaded on demand.
  useEffect(() => {
    let cancelled = false;
    const description = languageFor(path);
    if (!description) return;
    void description.load().then((support) => {
      if (!cancelled) viewRef.current?.dispatch({ effects: languageSlot.current.reconfigure(support) });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlySlot.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly]);

  const suggestionsOn = Boolean(suggest) && !readOnly;
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: suggestSlot.current.reconfigure(
        suggestionsOn ? inlineSuggestions((input, signal) => suggestRef.current?.(input, signal) ?? Promise.resolve("")) : [],
      ),
    });
  }, [suggestionsOn]);

  // Someone else's save, a live draft, or a reload: replace the text but keep
  // the cursor where it was (clamped to the new length).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    const head = Math.min(view.state.selection.main.head, value.length);
    applyingRef.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor: head } });
    applyingRef.current = false;
  }, [value]);

  return <div ref={hostRef} data-slot="studio-editor" className={cn("h-full min-h-0 overflow-hidden", className)} />;
}
