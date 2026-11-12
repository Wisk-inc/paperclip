export type StartupRecoveryPhase = "starting" | "recovering" | "ready";

/**
 * The startup step the server is on, as the health endpoint reports it while
 * the server is not ready yet. The label is a few plain words for people (the
 * Automa app shows it while it waits on Automa on the phone); it never carries
 * data from the database.
 */
export interface StartupStepSnapshot {
  id: string;
  label: string;
  /** Whole seconds since this step began. */
  seconds: number;
  /** The step's place in [STARTUP_STEP_ORDER] (1-based) and its length, when it is listed there. */
  number?: number;
  total?: number;
}

/**
 * The steps a start goes through once the port is open, in the order
 * index.ts runs them, so a waiting app can show how far along the start is
 * ("step 9 of 23"). A step not listed still shows, without a place. A test
 * keeps this list and index.ts in step.
 */
export const STARTUP_STEP_ORDER = [
  "runtime-operations",
  "execution-policy",
  "managed-environments",
  "deliveries",
  "plugins",
  "native-recovery",
  "hot-restart",
  "orphaned-runs",
  "scheduled-retries",
  "queued-runs",
  "goal-actions",
  "goals",
  "assigned-issues",
  "dependency-wakes",
  "task-watchdogs",
  "silent-runs",
  "stale-locks",
  "setup-sessions",
  "decisions",
  "adapter-logins",
  "setup-token-logins",
  "environment-leases",
  "adapters",
] as const;

export interface StartupRecoveryState {
  phase: StartupRecoveryPhase;
  updatedAt: string;
  /** Whole seconds since the server began starting. */
  seconds: number;
  /** The step in progress; null between steps and once ready. */
  step: StartupStepSnapshot | null;
}

interface LogLike {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

let phase: StartupRecoveryPhase = "ready";
let updatedAt = new Date().toISOString();
let startedAtMs = Date.now();
let currentStep: { id: string; label: string; startedAtMs: number } | null = null;

/** How often a step that is still running says so in the log. */
export const SLOW_STARTUP_STEP_NOTICE_MS = 30_000;

export function setStartupRecoveryPhase(next: StartupRecoveryPhase): void {
  // The clock starts when a start begins, not when the module loaded.
  if (next === "starting" && phase === "ready") startedAtMs = Date.now();
  phase = next;
  updatedAt = new Date().toISOString();
  if (next === "ready") currentStep = null;
}

/**
 * Marks one startup step as the one in progress. The returned function ends
 * it (a later step that already took over is left alone) and gives its length
 * in milliseconds.
 */
export function beginStartupStep(id: string, label: string): () => number {
  const step = { id, label, startedAtMs: Date.now() };
  currentStep = step;
  updatedAt = new Date().toISOString();
  return () => {
    if (currentStep === step) currentStep = null;
    return Date.now() - step.startedAtMs;
  };
}

/**
 * Runs one startup step: the health endpoint names it while it runs, the log
 * says how long it took, and one that runs long says so every
 * [SLOW_STARTUP_STEP_NOTICE_MS], so a slow phone's terminal never looks stuck
 * while Automa is in fact still working. Errors are the caller's to handle.
 */
export async function runStartupStep<T>(
  id: string,
  label: string,
  log: LogLike,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const end = beginStartupStep(id, label);
  // A one-shot timer that sets the next, not an interval: the server's only
  // intervals stay its schedulers (and tests that catch the scheduler's
  // interval keep catching it).
  let notice: ReturnType<typeof setTimeout> | null = null;
  const remindLater = () => {
    notice = setTimeout(() => {
      const seconds = Math.round((Date.now() - started) / 1000);
      log.warn({ step: id, seconds }, `Startup is still on: ${label} (${seconds}s so far)`);
      remindLater();
    }, SLOW_STARTUP_STEP_NOTICE_MS);
    notice.unref?.();
  };
  remindLater();
  try {
    return await work();
  } finally {
    if (notice) clearTimeout(notice);
    const ms = end();
    log.info({ step: id, ms }, `Startup step done: ${label}`);
  }
}

function stepSnapshot(step: { id: string; label: string; startedAtMs: number }, now: number): StartupStepSnapshot {
  const index = (STARTUP_STEP_ORDER as readonly string[]).indexOf(step.id);
  return {
    id: step.id,
    label: step.label,
    seconds: Math.max(0, Math.round((now - step.startedAtMs) / 1000)),
    ...(index >= 0 ? { number: index + 1, total: STARTUP_STEP_ORDER.length } : {}),
  };
}

export function getStartupRecoveryState(): StartupRecoveryState {
  const now = Date.now();
  return {
    phase,
    updatedAt,
    seconds: phase === "ready" ? 0 : Math.max(0, Math.round((now - startedAtMs) / 1000)),
    step: currentStep ? stepSnapshot(currentStep, now) : null,
  };
}

export function resetStartupRecoveryStateForTests(): void {
  phase = "ready";
  updatedAt = new Date().toISOString();
  startedAtMs = Date.now();
  currentStep = null;
}
