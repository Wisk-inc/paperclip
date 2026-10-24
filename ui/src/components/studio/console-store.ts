import { useSyncExternalStore } from "react";
import type { StudioConsoleLine } from "@paperclipai/shared";

/** The most lines kept, and the most drawn at once (the newest). */
const KEEP_LINES = 2000;
export const SHOWN_LINES = 500;
/** Output that arrives faster than this is drawn in one go. */
const FLUSH_MS = 200;

/**
 * Adds lines this console doesn't have yet, in line-number order: history
 * read after reconnecting fills the gap before live lines that arrived
 * first, instead of being dropped as old.
 */
export function mergeConsoleLines(current: StudioConsoleLine[], incoming: StudioConsoleLine[]) {
  if (!incoming.length) return current;
  const last = current.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
  if (incoming.every((line) => line.seq > last)) {
    return [...current, ...[...incoming].sort((a, b) => a.seq - b.seq)].slice(-KEEP_LINES);
  }
  const known = new Set(current.map((line) => line.seq));
  const fresh = incoming.filter((line) => !known.has(line.seq));
  if (!fresh.length) return current;
  return [...current, ...fresh].sort((a, b) => a.seq - b.seq).slice(-KEEP_LINES);
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

const noSubscribe = () => () => {};

/** The newest line printed since `since` (an ISO time), without colour codes. */
export function latestConsoleLine(lines: StudioConsoleLine[], since?: string | null): string {
  const from = since ? Date.parse(since) : Number.NaN;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (Number.isFinite(from) && Date.parse(line.at) < from) break;
    // eslint-disable-next-line no-control-regex
    const text = line.text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim();
    if (text) return text;
  }
  return "";
}

/** Redraws only when the newest line changes, not on every batch of output. */
export function useLatestConsoleLine(store: StudioConsoleStore | undefined, since?: string | null) {
  const read = () => (store ? latestConsoleLine(store.getSnapshot(), since) : "");
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, read, read);
}
