import { getPageVisibility } from "./page-visibility";
import type { InvalidateQueryFilters, QueryClient } from "@tanstack/react-query";

/**
 * Coalesces React Query invalidations triggered by the live-events stream.
 *
 * `LiveUpdatesProvider` used to call `queryClient.invalidateQueries(...)`
 * synchronously for every websocket event. During an active agent run these
 * fire many times per second, and each invalidation cascades into refetches
 * and re-renders — the dominant source of steady-state CPU churn (and, over a
 * long-lived tab, off-heap allocation growth).
 *
 * The batcher collects invalidation filters over a short window, de-duplicates
 * identical ones, and flushes them in a single pass at most once per interval.
 * A trailing-throttle (not a pure debounce) is used deliberately: during a
 * continuous event stream a pure debounce would never flush, so UI updates
 * would stall; throttling guarantees the buffered invalidations flush every
 * `intervalMs`.
 */
export interface InvalidationBatcher {
  /** Schedule an invalidation; resolves once the batched flush has run. */
  schedule: (filters: InvalidateQueryFilters) => Promise<void>;
  /** Flush any buffered invalidations immediately (e.g. before teardown). */
  flush: () => Promise<void>;
  dispose: () => void;
}

export const DEFAULT_INVALIDATION_INTERVAL_MS = 300;

/** How often a list that is costly to build may refetch during a burst. */
export const HEAVY_REFETCH_GAP_MS = 4000;

const HEAVY_ISSUE_LISTS = new Set(["mine-by-me", "touched-by-me", "unread-touched-by-me"]);

/**
 * Dashboards, badges, run lists and the agent and inbox lists are rebuilt by
 * the server from many tables. A busy run touches them with every event, so
 * they refetch at most once per gap (and once more after the burst ends).
 */
export function liveRefetchGapMs(filters: InvalidateQueryFilters): number {
  const key = filters.queryKey;
  if (!Array.isArray(key) || key.length === 0) return 0;
  const [root, , third] = key as readonly unknown[];
  if (root === "dashboard" || root === "sidebar-badges" || root === "heartbeats") return HEAVY_REFETCH_GAP_MS;
  if (root === "agents" && key.length === 2) return HEAVY_REFETCH_GAP_MS;
  if (root === "issues" && typeof third === "string" && HEAVY_ISSUE_LISTS.has(third)) return HEAVY_REFETCH_GAP_MS;
  return 0;
}

/** Data that live events never change, so a reconnect need not refetch it. */
const STATIC_QUERY_ROOTS = new Set(["adapters", "plugins", "instance", "auth", "health", "skills"]);

/**
 * What to refetch when the live connection opens or the page comes back:
 * everything on screen except data that events never change. Queries that
 * loaded while the socket was connecting are refetched too, since events in
 * that gap are not replayed.
 */
export function reconcileFilter(): InvalidateQueryFilters {
  return {
    type: "active",
    predicate: (query) => {
      const root = query.queryKey[0];
      return !(typeof root === "string" && STATIC_QUERY_ROOTS.has(root));
    },
  };
}

type Deferred = { promise: Promise<void>; resolve: () => void };

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function createInvalidationBatcher(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  intervalMs: number = DEFAULT_INVALIDATION_INTERVAL_MS,
  options: {
    /**
     * The least time between two refetches of the same key. Heavy background
     * lists (the dashboard, the run list, the inbox badge's sources) were
     * refetched on nearly every event; a key invalidated again sooner waits
     * for its turn and is then refetched once, so the final state still lands.
     */
    minIntervalMs?: (filters: InvalidateQueryFilters) => number;
    now?: () => number;
  } = {},
): InvalidationBatcher {
  // Keyed by a stable serialization of the filters so repeated invalidations of
  // the same key (the common case) collapse to one entry.
  const pending = new Map<string, InvalidateQueryFilters>();
  const lastFlushedAt = new Map<string, number>();
  const now = options.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDueAt = 0;
  // Resolves when the currently-buffered window has been flushed. `schedule`
  // hands this back so callers that await it observe the real invalidation.
  let windowDeferred: Deferred | null = null;

  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const deferred = windowDeferred;
    windowDeferred = null;
    if (pending.size === 0) {
      deferred?.resolve();
      return;
    }
    const at = now();
    const filtersList: InvalidateQueryFilters[] = [];
    let soonest = Number.POSITIVE_INFINITY;
    for (const [key, filters] of [...pending.entries()]) {
      const gap = options.minIntervalMs?.(filters) ?? 0;
      const last = lastFlushedAt.get(key);
      if (gap > 0 && last !== undefined && at - last < gap) {
        soonest = Math.min(soonest, last + gap);
        continue;
      }
      pending.delete(key);
      if (gap > 0) lastFlushedAt.set(key, at);
      filtersList.push(filters);
    }
    if (pending.size > 0 && soonest !== Number.POSITIVE_INFINITY) {
      // What is waiting for its turn goes out when the gap has passed.
      windowDeferred = createDeferred();
      const delay = Math.max(intervalMs, soonest - at);
      timerDueAt = at + delay;
      timer = setTimeout(() => void flush(), delay);
    }
    try {
      await Promise.all(filtersList.map((filters) => queryClient.invalidateQueries(
        getPageVisibility().visible ? filters : { ...filters, refetchType: "none" },
      )));
    } finally {
      deferred?.resolve();
    }
  };

  const schedule = (filters: InvalidateQueryFilters): Promise<void> => {
    pending.set(serializeFilters(filters), filters);
    if (windowDeferred === null) {
      windowDeferred = createDeferred();
    }
    // A key waiting out its gap must not hold back everything after it.
    const dueBy = now() + intervalMs;
    if (timer !== null && timerDueAt > dueBy) {
      clearTimeout(timer);
      timer = null;
    }
    if (timer === null) {
      timerDueAt = dueBy;
      timer = setTimeout(() => void flush(), intervalMs);
    }
    return windowDeferred.promise;
  };

  const dispose = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending.clear();
    // Release any awaiters so they don't hang forever after teardown.
    windowDeferred?.resolve();
    windowDeferred = null;
  };

  return { schedule, flush, dispose };
}

let uniqueFilterCounter = 0;

function serializeFilters(filters: InvalidateQueryFilters): string {
  // A predicate is an opaque function — two predicate-based filters can never be
  // proven equal, so never coalesce them (that would silently drop one). Give
  // each its own key.
  if (typeof filters.predicate === "function") {
    return `__predicate__:${(uniqueFilterCounter += 1)}`;
  }
  // queryKey drives the identity; refetchType/exact/type change the behavior, so
  // keep them distinct while still collapsing exact repeats.
  try {
    return JSON.stringify([
      filters.queryKey ?? null,
      filters.refetchType ?? null,
      filters.exact ?? null,
      filters.type ?? null,
    ]);
  } catch {
    // Non-serializable filter (shouldn't happen for our query keys) — fall back
    // to a unique key so it is never dropped.
    return `__nonserializable__:${(uniqueFilterCounter += 1)}`;
  }
}

/**
 * Wrap a QueryClient so `invalidateQueries` is routed through `batcher` while
 * every other method (reads, `setQueryData`, …) passes straight through to the
 * real client. Returned value is a `QueryClient` and can be used anywhere one
 * is expected. Private class fields keep working because methods are bound to
 * the real client via `Reflect.get(target, prop, target)`.
 *
 * The batched `invalidateQueries` returns a promise that resolves only after the
 * flush actually runs, so callers that await it still observe completion.
 */
export function createCoalescingQueryClient(
  queryClient: QueryClient,
  batcher: InvalidationBatcher,
): QueryClient {
  return new Proxy(queryClient, {
    get(target, prop) {
      if (prop === "invalidateQueries") {
        return (filters?: InvalidateQueryFilters) => batcher.schedule(filters ?? {});
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
