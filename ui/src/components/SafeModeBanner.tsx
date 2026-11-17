import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw, ShieldAlert, Stethoscope } from "lucide-react";
import { healthApi, type HealthStatus } from "../api/health";
import { Button } from "@/components/ui/button";
import { haptic } from "../lib/haptics";
import { queryKeys } from "../lib/queryKeys";
import { TroubleshootDialog } from "./TroubleshootDialog";

/** How often the board asks whether Automa is back after "Restart normally". */
export const SAFE_MODE_RESTART_POLL_MS = 2_000;
/** How long it waits for Automa to come back before saying so. */
export const SAFE_MODE_RESTART_PATIENCE_MS = 3 * 60_000;

type Phase =
  /** In safe mode; nothing asked yet. */
  | "idle"
  /** "Restart normally" was accepted: waiting for Automa to come back. */
  | "restarting"
  /** It came back, in safe mode again: it kept stopping while starting normally. */
  | "again"
  /** It hasn't come back in a few minutes. */
  | "slow";

function message(health: HealthStatus, phase: Phase): string {
  if (phase === "restarting") return "Restarting Automa normally… The board comes back by itself in a moment.";
  if (phase === "again") return "Automa stopped again while starting normally, so it's back in safe mode. Troubleshoot looks for the cause.";
  if (phase === "slow") return "Automa hasn't come back yet. On the phone, open Termux to see what it says, or Troubleshoot.";
  const paused = "Your board and everything in it are here; agents, schedules and plugins wait for a normal start.";
  return health.safeModeReason === "crashes"
    ? `Automa kept stopping while it started, so it started in safe mode. ${paused}`
    : `Automa started in safe mode, as asked. ${paused}`;
}

/**
 * Safe mode (server/src/safe-mode.ts): Automa's health says so, and this
 * strip across the top of the board says why and offers the way back.
 * "Restart normally" stops the server and the automa launcher in Termux starts
 * it again at once, without safe mode; the strip waits for it and goes away
 * when Automa is back. "Troubleshoot" runs the troubleshooter in Termux from
 * the Automa app and shows its report (elsewhere it says how to run it):
 * see TroubleshootDialog.
 */
export function SafeModeBanner({ health }: { health?: HealthStatus }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [troubleshooting, setTroubleshooting] = useState(false);
  // When the server that took "Restart normally" started: a safe mode answer
  // from a server that started later means it fell back again.
  const restartedFrom = useRef<string | null>(null);
  const safeMode = health?.safeMode === true;

  // Out of safe mode: nothing left to say. A later safe start begins afresh.
  useEffect(() => {
    if (safeMode) return;
    setPhase("idle");
    setError(null);
  }, [safeMode]);

  useEffect(() => {
    if (phase !== "restarting") return;
    const poll = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.health });
    }, SAFE_MODE_RESTART_POLL_MS);
    const patience = window.setTimeout(() => setPhase("slow"), SAFE_MODE_RESTART_PATIENCE_MS);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(patience);
    };
  }, [phase, queryClient]);

  const startedAt = health?.serverInfo?.processStartedAt ?? null;
  useEffect(() => {
    if (phase !== "restarting" || !safeMode) return;
    if (restartedFrom.current && startedAt && startedAt !== restartedFrom.current) setPhase("again");
  }, [phase, safeMode, startedAt]);

  if (!health || !safeMode) return null;

  const restartNormally = async () => {
    haptic("tick");
    setError(null);
    restartedFrom.current = startedAt;
    setPhase("restarting");
    try {
      await healthApi.restartNormally();
    } catch (failure) {
      haptic("warning");
      setPhase("idle");
      setError(failure instanceof Error ? failure.message : "Couldn't restart Automa.");
    }
  };

  const troubleshoot = () => {
    haptic("tick");
    setTroubleshooting(true);
  };

  const canRestart = health.safeModeRestartAvailable === true;
  const restarting = phase === "restarting";

  return (
    <>
      <div
        role="status"
        data-testid="safe-mode-banner"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-100"
      >
        <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 basis-64">
          <span className="font-semibold">Safe mode.</span> {message(health, phase)}
          {!canRestart ? " To start it normally, run automa restart in Termux." : null}
          {error ? <span role="alert" className="mt-1 block text-destructive">{error}</span> : null}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={troubleshoot} data-testid="safe-mode-troubleshoot">
            <Stethoscope />
            <span>Troubleshoot</span>
          </Button>
          {canRestart ? (
            <Button size="sm" onClick={() => void restartNormally()} disabled={restarting} data-testid="safe-mode-restart">
              <RotateCcw className={restarting ? "animate-spin motion-reduce:animate-none" : undefined} />
              <span>{restarting ? "Restarting…" : "Restart normally"}</span>
            </Button>
          ) : null}
        </div>
      </div>

      <TroubleshootDialog open={troubleshooting} onOpenChange={setTroubleshooting} />
    </>
  );
}
