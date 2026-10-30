import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "automa.waitNotice.dismissed";
/** A dismissal never outlives a day, even if the page never saw the wait end. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Dismissals = Record<string, number>;

const listeners = new Set<() => void>();

function read(): Dismissals {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  } catch {
    return {};
  }
}

function write(next: Dismissals) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: nothing persists, and the notice comes back on reload.
  }
  for (const listener of listeners) listener();
}

export function isWaitNoticeDismissed(issueId: string, now = Date.now()): boolean {
  const at = read()[issueId];
  return typeof at === "number" && now - at < MAX_AGE_MS;
}

/** Hides the waiting notice (banner and composer strip) for this task until its wait ends. */
export function dismissWaitNotice(issueId: string, now = Date.now()) {
  const fresh = Object.fromEntries(Object.entries(read()).filter(([, at]) => now - at < MAX_AGE_MS));
  write({ ...fresh, [issueId]: now });
}

export function clearWaitNoticeDismissal(issueId: string) {
  const current = read();
  if (!(issueId in current)) return;
  const { [issueId]: _cleared, ...rest } = current;
  write(rest);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWaitNoticeDismissed(issueId: string | null | undefined): boolean {
  const getSnapshot = useCallback(() => (issueId ? isWaitNoticeDismissed(issueId) : false), [issueId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
