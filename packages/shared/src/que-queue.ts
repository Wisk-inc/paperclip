import { QUE_MAX_IN_FLIGHT, QUE_PER_MODEL_IN_FLIGHT } from "./que.js";

/** Ends a turn; calling it again does nothing. */
export type QueRelease = () => void;

// A turn its holder never ended (a stream whose reader dropped it) ends itself after this long.
const TURN_LIMIT_MS = 10 * 60_000;

interface Waiter {
  key: string | null;
  start: () => void;
}

const waiters: Waiter[] = [];
let inFlight = 0;
let started = 0;
let peakInFlight = 0;
/** How many turns each model holds, so one model never floods the service (it refuses a burst to one model). */
const perModel = new Map<string, number>();

function canStart(key: string | null): boolean {
  if (inFlight >= QUE_MAX_IN_FLIGHT) return false;
  return key === null || (perModel.get(key) ?? 0) < QUE_PER_MODEL_IN_FLIGHT;
}

/** Starts as many waiting callers as both limits allow, oldest first, skipping a model that is full. */
function pump(): void {
  for (let i = 0; i < waiters.length && inFlight < QUE_MAX_IN_FLIGHT; ) {
    if (canStart(waiters[i]!.key)) waiters.splice(i, 1)[0]!.start();
    else i += 1;
  }
}

function begin(key: string | null): QueRelease {
  inFlight += 1;
  started += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  if (key !== null) perModel.set(key, (perModel.get(key) ?? 0) + 1);
  let ended = false;
  const timer = setTimeout(end, TURN_LIMIT_MS);
  timer.unref();
  function end() {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    inFlight -= 1;
    if (key !== null) {
      const left = (perModel.get(key) ?? 1) - 1;
      if (left > 0) perModel.set(key, left);
      else perModel.delete(key);
    }
    pump();
  }
  return end;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Waits for a turn with the free-model service: at most QUE_MAX_IN_FLIGHT
 * calls run at once across all models, and at most QUE_PER_MODEL_IN_FLIGHT on
 * any one model. The rest wait in arrival order (none is dropped); a caller
 * whose signal aborts leaves the line.
 */
export function queTurn(signal?: AbortSignal, model?: string): Promise<QueRelease> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const key = model ?? null;
  if (waiters.length === 0 && canStart(key)) return Promise.resolve(begin(key));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const at = waiters.indexOf(waiter);
      if (at !== -1) waiters.splice(at, 1);
      reject(abortReason(signal!));
    };
    const waiter: Waiter = {
      key,
      start: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(begin(key));
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.push(waiter);
    pump();
  });
}

export function queQueueStats(): { maxInFlight: number; inFlight: number; waiting: number; started: number; peakInFlight: number } {
  return { maxInFlight: QUE_MAX_IN_FLIGHT, inFlight, waiting: waiters.length, started, peakInFlight };
}

/** Starts the counters again (tests). Turns in flight are left alone. */
export function resetQueQueueStats(): void {
  started = 0;
  peakInFlight = inFlight;
}
