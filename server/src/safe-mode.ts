/**
 * Safe start (Automa 1.9.12). When Automa keeps stopping while it starts, the
 * `automa` launcher in Termux starts it once more with PAPERCLIP_SAFE_MODE=1
 * (or the person asks for it: `automa run --safe`). The server then starts
 * only what the board needs: the database, the API and the board itself.
 * Agents, schedules and startup recovery (the heartbeat scheduler), plugins,
 * runtime services, the Moan knowledge index and message deliveries wait for
 * a normal start, so the board opens and the person can see and fix what is
 * wrong. Nothing is deleted or changed by starting this way.
 */

/** The exit code that asks the `automa` launcher to start the server again, normally and at once. */
export const NORMAL_RESTART_EXIT_CODE = 75;

/** Why the server started in safe mode: it kept stopping while starting, or someone asked for it. */
export type SafeModeReason = "crashes" | "asked";

function flag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function safeModeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env.PAPERCLIP_SAFE_MODE);
}

/** A fixed word, never free text: it rides health answers anyone on the phone can read. */
export function safeModeReasonFromEnv(env: NodeJS.ProcessEnv = process.env): SafeModeReason {
  return env.AUTOMA_SAFE_REASON?.trim() === "crashes" ? "crashes" : "asked";
}

/**
 * "Restart normally", at most once: a second request while the server is
 * already stopping (another tab, a double tap) must not stop it twice.
 */
export function restartOnce(stopForNormalStart: () => void): () => void {
  let requested = false;
  return () => {
    if (requested) return;
    requested = true;
    stopForNormalStart();
  };
}

/** Whether the `automa` launcher supervises this server, so an exit with [NORMAL_RESTART_EXIT_CODE] starts it again. */
export function startedByAutomaLauncher(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env.AUTOMA_LAUNCHER);
}
