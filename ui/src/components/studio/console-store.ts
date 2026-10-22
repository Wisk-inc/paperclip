import { useSyncExternalStore } from "react";
import type { StudioConsoleLine } from "@paperclipai/shared";

/** The most lines kept, and the most drawn at once (the newest). */
const KEEP_LINES = 2000;
export const SHOWN_LINES = 500;
/** Output that arrives faster than this is drawn in one go. */
const FLUSH_MS = 200;

export function mergeConsoleLines(current: StudioConsoleLine[], incoming: StudioConsoleLine[]) {
  if (!incoming.length) return current;
  const last = current.at(-1)?.seq ?? 0;
  const fresh = incoming.filter((line) => line.seq > last);
  if (!fresh.length) return current;
  return [...current, ...fresh].slice(-KEEP_LINES);
}

/**
 * A project's console output, outside React state: a chatty program used to
 * re-render the whole Studio screen for every batch of lines, which froze the
 * phone. New lines are collected and drawn a few times a second, and only the
 * console itself redraws.
 */
export interface StudioConsoleStore {
  getSnapshot: () => StudioConsoleLine[];
  subscribe: (listener: () => void) => () => void;
  /** Live output: drawn on the next flush. */
  push: (lines: StudioConsoleLine[]) => void;
  /** Output read from the server (on open or reconnect): drawn now. */
  merge: (lines: StudioConsoleLine[]) => void;
  clear: () => void;
}

export function createStudioConsoleStore(): StudioConsoleStore {
  let lines: StudioConsoleLine[] = [];
  let pending: StudioConsoleLine[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const flush = () => {
    timer = null;
    if (!pending.length) return;
    const next = mergeConsoleLines(lines, pending);
    pending = [];
    if (next !== lines) {
      lines = next;
      notify();
    }
  };
  return {
    getSnapshot: () => lines,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(incoming) {
      if (!incoming.length) return;
      pending.push(...incoming);
      if (timer === null) timer = setTimeout(flush, FLUSH_MS);
    },
    merge(incoming) {
      flush();
      const next = mergeConsoleLines(lines, incoming);
      if (next !== lines) {
        lines = next;
        notify();
      }
    },
    clear() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = [];
      lines = [];
      notify();
    },
  };
}

export function useStudioConsoleLines(store: StudioConsoleStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
