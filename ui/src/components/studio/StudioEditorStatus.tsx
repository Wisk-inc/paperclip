import { useSyncExternalStore } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EditorCursor } from "./CodeEditor";
import { fileKind } from "./file-kinds";

export type StudioSaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

/** How far CodeEditor indents: two spaces (CodeMirror's own indent unit, which it keeps). */
const INDENT_SPACES = 2;

/**
 * Where the cursor is, outside React state: the editor reports every move,
 * and only the status bar redraws for it, not the whole Studio screen.
 */
export interface EditorCursorStore {
  getSnapshot: () => EditorCursor | null;
  subscribe: (listener: () => void) => () => void;
  /** The new place, or null when no editor is open. */
  set: (cursor: EditorCursor | null) => void;
}

export function createEditorCursorStore(): EditorCursorStore {
  let cursor: EditorCursor | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => cursor,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (next === cursor) return;
      if (next && cursor && next.line === cursor.line && next.column === cursor.column && next.selected === cursor.selected) return;
      cursor = next;
      for (const listener of listeners) listener();
    },
  };
}

interface StudioEditorStatusProps {
  /** The open file's path, or null when no file is open. */
  path: string | null;
  cursorStore: EditorCursorStore;
  saveState: StudioSaveState;
  /** Grey AI suggestions while typing are on. */
  suggestOn: boolean;
  onToggleSuggest: () => void;
}

/**
 * The line under the editor: where the cursor is, the file's language and the
 * indent on the left; the AI suggestions switch and whether the file is saved
 * on the right. When the line is too narrow, the left side drops its last
 * items whole instead of cutting one off, and the switch shows as its icon.
 */
export function StudioEditorStatus({ path, cursorStore, saveState, suggestOn, onToggleSuggest }: StudioEditorStatusProps) {
  const cursor = useSyncExternalStore(cursorStore.subscribe, cursorStore.getSnapshot, cursorStore.getSnapshot);
  const item = "flex h-7 shrink-0 items-center whitespace-nowrap";
  return (
    <div
      className="@container flex h-7 shrink-0 items-center gap-2 overflow-hidden border-t border-border bg-card pr-2 pl-3 text-xs text-muted-foreground"
      data-testid="studio-editor-status"
    >
      {/* One line high and wrapping: an item with no room goes to a second line, which is out of sight. */}
      <div className="flex h-7 min-w-0 flex-1 flex-wrap content-start gap-x-3 overflow-hidden">
        {cursor ? (
          <span className={cn(item, "gap-1 tabular-nums")}>
            <span data-testid="studio-cursor-position">
              Ln {cursor.line}, Col {cursor.column}
            </span>
            {cursor.selected ? <span data-testid="studio-cursor-selected">({cursor.selected} selected)</span> : null}
          </span>
        ) : null}
        {path ? (
          <span className={item} data-testid="studio-file-language">
            {fileKind(path.slice(path.lastIndexOf("/") + 1)).label}
          </span>
        ) : null}
        {cursor ? (
          <span className={item} data-testid="studio-indent">
            Spaces: {INDENT_SPACES}
          </span>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onToggleSuggest}
        aria-pressed={suggestOn}
        aria-label={suggestOn ? "AI suggest" : "AI suggest off"}
        title="Grey AI suggestions while you type (Tab or tap to accept)"
        className={cn(
          "h-5 rounded-full border px-2 font-normal",
          suggestOn
            ? "border-primary/50 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary dark:hover:bg-primary/20"
            : "border-border text-muted-foreground",
        )}
        data-testid="studio-suggest-toggle"
      >
        <Sparkles aria-hidden="true" />
        {/* A very narrow editor keeps the save state readable and shows the switch as its icon. */}
        <span className="hidden @3xs:inline">{suggestOn ? "AI suggest" : "AI suggest off"}</span>
      </Button>
      <span
        className={cn("shrink-0 whitespace-nowrap", saveState === "error" || saveState === "conflict" ? "text-destructive" : null)}
        data-testid="studio-save-state"
      >
        {saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Edited" : saveState === "error" ? "Not saved" : saveState === "conflict" ? "Changed elsewhere" : path ? "Saved" : ""}
      </span>
    </div>
  );
}
