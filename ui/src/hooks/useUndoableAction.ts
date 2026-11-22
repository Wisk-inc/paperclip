import { useCallback, useEffect, useRef, useState } from "react";
import { useToastActions } from "../context/ToastContext";
import { haptic } from "../lib/haptics";

/** How long Undo stays available before the action is sent to the server. */
export const UNDO_WINDOW_MS = 6000;

interface UndoableActionOptions {
  /**
   * Sends the action to the server. A rejected promise brings the item back.
   * The id stops being hidden when this promise settles, so resolve it only
   * after the list has been read again (return or await the refresh);
   * otherwise the item shows for a moment before the new list arrives.
   */
  commit: (id: string) => Promise<unknown>;
  windowMs?: number;
}

/**
 * Optimistic destructive actions with Undo. The item leaves the list at
 * once, a toast offers Undo, and the server call runs only when the Undo
 * window closes. Leaving the page commits whatever is still waiting, so the
 * person's intent is never silently dropped.
 */
export function useUndoableAction({ commit, windowMs = UNDO_WINDOW_MS }: UndoableActionOptions) {
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const { pushToast } = useToastActions();

  const show = useCallback((id: string) => {
    setHiddenIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const send = useCallback(
    (id: string) => {
      timers.current.delete(id);
      // The id is hidden only while the action is on its way. On failure the
      // item comes back. On success the refreshed list no longer has it, and
      // something new with the same id (a file made again under that name)
      // must be listed. A second run of the same id that is still waiting
      // keeps it hidden.
      const settle = () => {
        if (!timers.current.has(id)) show(id);
      };
      commitRef.current(id).then(settle, settle);
    },
    [show],
  );

  const undo = useCallback(
    (id: string) => {
      const timer = timers.current.get(id);
      if (!timer) return;
      clearTimeout(timer);
      timers.current.delete(id);
      show(id);
    },
    [show],
  );

  const run = useCallback(
    (id: string, toastTitle: string) => {
      if (timers.current.has(id)) return;
      setHiddenIds((current) => new Set(current).add(id));
      haptic("tick");
      pushToast({
        title: toastTitle,
        tone: "info",
        ttlMs: windowMs,
        action: { label: "Undo", onClick: () => undo(id) },
      });
      timers.current.set(
        id,
        setTimeout(() => send(id), windowMs),
      );
    },
    [pushToast, send, undo, windowMs],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const [id, timer] of pending) {
        clearTimeout(timer);
        void commitRef.current(id).catch(() => undefined);
      }
      pending.clear();
    };
  }, []);

  return { hiddenIds, run };
}
