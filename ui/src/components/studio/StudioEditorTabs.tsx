import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import type { StudioFileNode } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { fileKind } from "./file-kinds";

/** The most tabs kept open. Opening one more closes the oldest tab that is not the open file. */
export const MAX_EDITOR_TABS = 12;

/** `tabs` with `path` open: a new path goes at the end, and over the limit the oldest other tab closes. */
export function withTab(tabs: string[], path: string, limit = MAX_EDITOR_TABS): string[] {
  if (tabs.includes(path)) return tabs;
  const next = [...tabs, path];
  while (next.length > limit) next.splice(next.findIndex((tab) => tab !== path), 1);
  return next;
}

/** True for `parent` itself and for everything inside it when it is a folder. */
export function isAtOrUnder(path: string, parent: string) {
  return path === parent || path.startsWith(`${parent}/`);
}

/** `tabs` without `path` and, when it is a folder, without the files inside it. */
export function withoutTabs(tabs: string[], path: string): string[] {
  return tabs.some((tab) => isAtOrUnder(tab, path)) ? tabs.filter((tab) => !isAtOrUnder(tab, path)) : tabs;
}

/** Where `path` is after the file or folder `from` moved to `to` (unchanged when it was not part of the move). */
export function movedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

/** `tabs` after the file or folder `from` moved to `to`: its tab, and the tabs of files inside it, take the new path. */
export function renameTabs(tabs: string[], from: string, to: string): string[] {
  if (!tabs.some((tab) => isAtOrUnder(tab, from))) return tabs;
  // A move onto a file that had its own tab leaves one tab, not two.
  return [...new Set(tabs.map((tab) => movedPath(tab, from, to)))];
}

/**
 * The tab to show when `path` closes: the nearest one to its right, otherwise
 * the nearest to its left, otherwise none. `closing` names every tab that
 * closes with it (a deleted folder takes several).
 */
export function neighbourTab(tabs: string[], path: string, closing: (tab: string) => boolean = (tab) => tab === path): string | null {
  const index = tabs.indexOf(path);
  if (index === -1) return tabs.findLast((tab) => !closing(tab)) ?? null;
  return tabs.slice(index + 1).find((tab) => !closing(tab)) ?? tabs.slice(0, index).findLast((tab) => !closing(tab)) ?? null;
}

/** Whether the tree still has the file. Files inside a folder the tree does not list count as there. */
function treeHasFile(nodes: StudioFileNode[], path: string): boolean {
  for (const node of nodes) {
    if (node.type === "file") {
      if (node.path === path) return true;
    } else if (path.startsWith(`${node.path}/`)) {
      return node.unlisted ? true : treeHasFile(node.children ?? [], path);
    }
  }
  return false;
}

/** `tabs` without the files the tree no longer has. A tab `keep` names stays whatever the tree says. */
export function existingTabs(tabs: string[], tree: StudioFileNode[], keep: (tab: string) => boolean = () => false): string[] {
  const next = tabs.filter((tab) => keep(tab) || treeHasFile(tree, tab));
  return next.length === tabs.length ? tabs : next;
}

export interface RememberedTabs {
  tabs: string[];
  /** The file that was open. */
  active: string | null;
}

export function editorTabsStorageKey(workspaceId: string) {
  return `automa.studio.tabs.${workspaceId}`;
}

/** The tabs this browser had open in the workspace last time (none when storage is off or holds something else). */
export function readRememberedTabs(workspaceId: string): RememberedTabs {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(editorTabsStorageKey(workspaceId)) ?? "null");
    const stored = Array.isArray(parsed) ? { tabs: parsed } : parsed && typeof parsed === "object" ? (parsed as { tabs?: unknown; active?: unknown }) : null;
    if (stored && Array.isArray(stored.tabs)) {
      const tabs = [...new Set(stored.tabs.filter((tab): tab is string => typeof tab === "string" && tab.length > 0))].slice(-MAX_EDITOR_TABS);
      const active = "active" in stored && typeof stored.active === "string" && tabs.includes(stored.active) ? stored.active : null;
      return { tabs, active };
    }
  } catch {
    // storage unavailable, or not what this page wrote
  }
  return { tabs: [], active: null };
}

export function rememberTabs(workspaceId: string, tabs: string[], active: string | null) {
  try {
    window.localStorage.setItem(editorTabsStorageKey(workspaceId), JSON.stringify({ tabs, active }));
  } catch {
    // storage unavailable
  }
}

function nameOf(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The file's language logo, or an icon for its kind (the same picture the file tree shows). */
function TabIcon({ name }: { name: string }) {
  const kind = fileKind(name);
  const [failed, setFailed] = useState(false);
  if (kind.logo && !failed) return <img src={kind.logo} alt="" className="size-4 shrink-0 object-contain" onError={() => setFailed(true)} />;
  const Icon = kind.icon;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

interface StudioEditorTabsProps {
  /** Paths of the open files, in the order they were opened. */
  tabs: string[];
  /** The file in the editor. */
  activePath: string | null;
  /** A file is being read. */
  loading?: boolean;
  /** The file in the editor has edits that are not saved yet. */
  dirty?: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** Phones: the "+" at the end of the strip shows the file list. Left out where the list is already on screen. */
  onShowFiles?: () => void;
}

/**
 * The open files as a strip of tabs above the editor. The open file's tab
 * takes the editor's background so the two read as one piece. The strip
 * scrolls sideways and keeps the open file's tab in view.
 */
export function StudioEditorTabs({ tabs, activePath, loading = false, dirty = false, onSelect, onClose, onShowFiles }: StudioEditorTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  // Two open files with one name also show their folder.
  const sharedNames = useMemo(() => {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const path of tabs) {
      const name = nameOf(path);
      if (seen.has(name)) shared.add(name);
      seen.add(name);
    }
    return shared;
  }, [tabs]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const reveal = () => {
      const tab = strip.querySelector<HTMLElement>('[data-active="true"]');
      // Nothing to measure while the pane is hidden; the observer below runs this again when it shows.
      if (!tab || !strip.clientWidth) return;
      const left = tab.offsetLeft;
      const right = left + tab.offsetWidth;
      if (left < strip.scrollLeft) strip.scrollLeft = left;
      else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
    };
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [activePath, tabs]);

  // Arrow keys move between tabs; Enter or Space opens the one in focus, Delete closes it.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Delete") {
      event.preventDefault();
      onClose(tabs[index]!);
      return;
    }
    const last = tabs.length - 1;
    const target =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  };

  // Each piece of the strip draws its own bottom line, so the open file's tab can leave it out.
  const piece = "box-content min-h-9 border-b border-border";
  return (
    <div className="flex shrink-0 items-stretch bg-muted/40" data-testid="studio-editor-tabs">
      <span
        className={tabs.length ? "sr-only" : cn(piece, "flex min-w-0 items-center px-3 text-xs text-muted-foreground")}
        data-testid="studio-open-file"
      >
        {activePath ?? (loading ? "Opening…" : "No file open")}
      </span>
      <div ref={stripRef} role="tablist" aria-label="Open files" className="relative flex min-w-0 scrollbar-none items-stretch overflow-x-auto overscroll-x-contain">
        {tabs.map((path, index) => {
          const name = nameOf(path);
          const folder = sharedNames.has(name) ? path.slice(0, Math.max(0, path.lastIndexOf("/"))) : "";
          const active = path === activePath;
          return (
            <div
              key={path}
              role="presentation"
              data-active={active}
              className={cn(
                piece,
                "group relative flex max-w-56 shrink-0 items-stretch border-r",
                active ? "border-b-transparent bg-(--studio-editor-bg) text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {active ? <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" aria-hidden="true" /> : null}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active || (!activePath && index === 0) ? 0 : -1}
                title={path}
                onClick={() => onSelect(path)}
                onAuxClick={(event) => {
                  // A middle click closes the tab, as in a browser.
                  if (event.button !== 1) return;
                  event.preventDefault();
                  onClose(path);
                }}
                onKeyDown={(event) => onKeyDown(event, index)}
                className="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-3 text-left outline-none ring-ring/50 ring-inset focus-visible:ring-2"
                data-testid="studio-file-tab"
                data-path={path}
              >
                <TabIcon name={name} />
                <span className="truncate font-mono text-xs" translate="no">
                  {name}
                </span>
                {folder ? (
                  <span className="max-w-24 shrink-0 truncate text-(length:--text-micro) text-muted-foreground" translate="no">
                    {folder}
                  </span>
                ) : null}
                {active && dirty ? (
                  <>
                    <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" data-testid="studio-file-tab-edited" />
                    <span className="sr-only">Edited</span>
                  </>
                ) : null}
              </button>
              <button
                type="button"
                aria-label={`Close ${name}`}
                title={`Close ${name}`}
                onClick={() => onClose(path)}
                className="group/close flex w-7 shrink-0 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground pointer-coarse:w-9"
                data-testid="studio-file-tab-close"
              >
                <span className="flex size-5 items-center justify-center rounded-sm group-hover/close:bg-accent group-focus-visible/close:bg-accent">
                  <X className="size-3.5" aria-hidden="true" />
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {onShowFiles ? (
        <button
          type="button"
          aria-label="Open another file"
          title="Open another file"
          onClick={onShowFiles}
          className={cn(piece, "flex w-10 shrink-0 items-center justify-center text-muted-foreground outline-none ring-ring/50 ring-inset hover:bg-accent/50 hover:text-foreground focus-visible:ring-2")}
          data-testid="studio-file-tab-add"
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      <span className={cn(piece, "min-w-0 flex-1")} aria-hidden="true" />
    </div>
  );
}
