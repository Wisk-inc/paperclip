import type { Query, QueryClient } from "@tanstack/react-query";
import { ApiError, isNetworkError } from "@/api/client";

/**
 * The Automa Android app sends this to the page when its server answers again
 * after it did not (the network came back, or Automa on the phone finished
 * restarting). MainActivity dispatches it by this exact name.
 */
export const SERVER_BACK_EVENT = "automa:server-back";

/** How long a lost connection waits between checks of the server, growing to the last. */
export const RECONNECT_CHECK_DELAYS_MS = [2_000, 4_000, 8_000, 10_000] as const;

/**
 * A request that failed for want of the server: it never reached it
 * (offline, refused, Automa restarting), or the server answered that it is
 * not able to serve right now (a 5xx while its database starts).
 */
export function isReachabilityError(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  if (error instanceof ApiError) return error.status >= 500;
  // A raw fetch outside the API client: the browser's "Failed to fetch".
  return error instanceof TypeError;
}

/** React Query retry rule: keep asking while the server can't be reached, never on a real answer. */
export function retryWhileUnreachable(_failureCount: number, error: unknown): boolean {
  return isReachabilityError(error);
}

/** The wait before retry `attempt` (0-based): 1 s, 2 s, 4 s, 8 s, then every 10 s. */
export function reconnectRetryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 10_000);
}

/** A query whose last try failed because the server could not be reached. */
export function failedToReachServer(query: Query): boolean {
  return query.state.status === "error" && isReachabilityError(query.state.error);
}

export interface ConnectionRecoveryDeps {
  /** Checks the server; resolves true once it answers. */
  checkServer: () => Promise<boolean>;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  isVisible: () => boolean;
}

function defaultDeps(): ConnectionRecoveryDeps {
  return {
    checkServer: async () => {
      try {
        const response = await fetch("/api/health", {
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    target: window,
    isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  };
}

/**
 * Brings the board back by itself after the connection drops. Requests that
 * failed for want of the server used to stay failed ("Failed to fetch") until
 * the app was reopened. Now, once one fails, the server is checked every few
 * seconds, and the moment it answers (or the network comes back, the page is
 * shown again, or the Automa app says its server is back) every request that
 * failed that way is made again. Returns a function that stops it.
 */
export function startConnectionRecovery(
  queryClient: QueryClient,
  deps: ConnectionRecoveryDeps = defaultDeps(),
): () => void {
  let stopped = false;
  let timer: unknown = null;
  let attempt = 0;
  let checking = false;

  const hasFailedQueries = () => queryClient.getQueryCache().findAll({ predicate: failedToReachServer }).length > 0;

  const cancelTimer = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const recover = () => {
    cancelTimer();
    attempt = 0;
    // Only what is on screen is fetched now; the rest is fetched when shown.
    void queryClient.refetchQueries({ predicate: failedToReachServer, type: "active" });
    queryClient
      .getQueryCache()
      .findAll({ predicate: failedToReachServer, type: "inactive" })
      .forEach((query) => query.invalidate());
  };

  const schedule = () => {
    if (stopped || timer !== null || checking) return;
    const delay = RECONNECT_CHECK_DELAYS_MS[Math.min(attempt, RECONNECT_CHECK_DELAYS_MS.length - 1)]!;
    attempt += 1;
    timer = deps.setTimer(() => {
      timer = null;
      void check();
    }, delay);
  };

  const check = async () => {
    if (stopped || checking) return;
    if (!hasFailedQueries()) {
      attempt = 0;
      return;
    }
    checking = true;
    let answered = false;
    try {
      answered = await deps.checkServer();
    } finally {
      checking = false;
    }
    if (stopped) return;
    if (answered) recover();
    else schedule();
  };

  // Something says the connection may be back: check now, not at the next tick.
  const checkNow = () => {
    if (stopped || !hasFailedQueries()) return;
    cancelTimer();
    void check();
  };

  const onVisibility = () => {
    if (deps.isVisible()) checkNow();
  };

  // The app saw its server answer: no need to ask again.
  const onServerBack = () => {
    if (!stopped && hasFailedQueries()) recover();
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (stopped || event.type !== "updated" || event.action.type !== "error") return;
    if (failedToReachServer(event.query)) schedule();
  });

  deps.target.addEventListener("online", checkNow);
  deps.target.addEventListener("focus", checkNow);
  deps.target.addEventListener("pageshow", checkNow);
  deps.target.addEventListener("visibilitychange", onVisibility);
  deps.target.addEventListener(SERVER_BACK_EVENT, onServerBack);
  // Failures from before this started (the very first requests) count too.
  if (hasFailedQueries()) schedule();

  return () => {
    stopped = true;
    cancelTimer();
    unsubscribe();
    deps.target.removeEventListener("online", checkNow);
    deps.target.removeEventListener("focus", checkNow);
    deps.target.removeEventListener("pageshow", checkNow);
    deps.target.removeEventListener("visibilitychange", onVisibility);
    deps.target.removeEventListener(SERVER_BACK_EVENT, onServerBack);
  };
}
