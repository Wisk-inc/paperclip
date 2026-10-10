import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { healthApi, type DevServerHealthStatus } from "../api/health";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { haptic } from "@/lib/haptics";
import { Mascot } from "./mascot/Mascot";

const RESTART_PENDING_RESET_MS = 30_000;

function formatRelativeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function describeReason(devServer: DevServerHealthStatus): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return "Backend files changed and migrations are pending.";
  }
  if (devServer.reason === "pending_migrations") {
    return "Pending migrations need a fresh boot.";
  }
  return "Backend files changed since this server booted.";
}

/**
 * Tells a developer the dev server is running stale code. It opens as a card
 * in the middle of the screen over a blurred scrim, where the thumb reaches
 * "Restart now" without stretching to the top. "Later" tucks it into a small
 * tab on the right edge, halfway down, that opens the card again.
 */
export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const [restartPending, setRestartPending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const restartRequired = Boolean(devServer?.enabled && devServer.restartRequired);

  useEffect(() => {
    if (!restartPending) return;
    const timeout = window.setTimeout(() => {
      setRestartPending(false);
    }, RESTART_PENDING_RESET_MS);
    return () => window.clearTimeout(timeout);
  }, [restartPending]);

  // A new stale period (after a restart) opens the card again.
  useEffect(() => {
    if (!restartRequired) setDismissed(false);
  }, [restartRequired]);

  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const currentDevServer = devServer;
  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt);
  const sample = devServer.changedPathsSample.slice(0, 3);
  const activeRunLabel = `${devServer.activeRunCount} live run${
    devServer.activeRunCount === 1 ? "" : "s"
  }`;
  const interrupts = devServer.activeRunCount > 0;

  async function requestRestartNow() {
    // With live runs, the first tap only arms the button; the second restarts.
    if (currentDevServer.activeRunCount > 0 && !armed) {
      haptic("warning");
      setArmed(true);
      return;
    }

    haptic("tick");
    setArmed(false);
    setError(null);
    setRestartPending(true);
    try {
      await healthApi.requestDevServerRestart();
    } catch (failure) {
      setRestartPending(false);
      haptic("warning");
      setError(failure instanceof Error ? failure.message : "Failed to request restart");
    }
  }

  const closeCard = () => {
    setArmed(false);
    setDismissed(true);
  };

  return (
    <>
      <Dialog open={!dismissed} onOpenChange={(open) => (open ? setDismissed(false) : closeCard())}>
        <DialogPortal>
          <DialogOverlay className="bg-black/40 backdrop-blur-md" />
          <DialogPrimitive.Content
            ref={cardRef}
            data-testid="dev-restart-card"
            // Focus the card, not "Later", so neither button looks pre-selected.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              cardRef.current?.focus();
            }}
            className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 fixed top-(--pct-50) left-(--pct-50) z-50 flex w-full max-w-(--sz-calc-25) translate-x-(--pct-neg-50) translate-y-(--pct-neg-50) flex-col gap-4 rounded-2xl border border-border bg-background p-5 shadow-lg duration-150 outline-none sm:max-w-md motion-reduce:animate-none"
          >
            <div className="flex flex-col items-center gap-2 text-center">
              <Mascot pose="confused" size="sm" />
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps) text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>Restart Required</span>
                {devServer.autoRestartEnabled ? (
                  <Badge variant="ghost" className="bg-amber-500/10 text-(length:--text-nano) tracking-(--tracking-eyebrow)">
                    Auto-Restart On
                  </Badge>
                ) : null}
              </div>
              <DialogPrimitive.Title className="text-lg font-semibold">The server is running old code</DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-sm text-muted-foreground">
                {describeReason(devServer)}
                {changedAt ? ` Updated ${changedAt}.` : ""}
              </DialogPrimitive.Description>
            </div>

            {sample.length > 0 || devServer.pendingMigrations.length > 0 ? (
              <div className="flex flex-col gap-1 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                {sample.length > 0 ? (
                  <span className="break-words">
                    Changed: <span className="font-mono">{sample.join(", ")}</span>
                    {devServer.changedPathCount > sample.length ? ` +${devServer.changedPathCount - sample.length} more` : ""}
                  </span>
                ) : null}
                {devServer.pendingMigrations.length > 0 ? (
                  <span className="break-words">
                    Pending migrations: <span className="font-mono">{devServer.pendingMigrations.slice(0, 2).join(", ")}</span>
                    {devServer.pendingMigrations.length > 2 ? ` +${devServer.pendingMigrations.length - 2} more` : ""}
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
              {devServer.waitingForIdle ? (
                <>
                  <TimerReset className="size-3.5 shrink-0" />
                  <span>Waiting for {activeRunLabel} to finish</span>
                </>
              ) : devServer.autoRestartEnabled ? (
                <>
                  <RotateCcw className="size-3.5 shrink-0" />
                  <span>Auto-restart will trigger when the instance is idle</span>
                </>
              ) : (
                <>
                  <RotateCcw className="size-3.5 shrink-0" />
                  <span>
                    Restart <code>pnpm dev:once</code> after the active work is safe to interrupt
                  </span>
                </>
              )}
            </div>

            {armed ? (
              <p role="alert" className="text-center text-sm font-medium text-amber-700 dark:text-amber-300">
                Restarting now may interrupt {activeRunLabel}. Tap again to restart.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-center text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <div className="flex items-center gap-2">
              <Button variant="outline" size="lg" className="h-11 flex-1" onClick={closeCard}>
                Later
              </Button>
              <Button
                size="lg"
                variant={armed ? "destructive" : "default"}
                className="h-11 flex-1"
                onClick={() => {
                  void requestRestartNow();
                }}
                disabled={restartPending}
                data-testid="dev-restart-now"
              >
                <RotateCcw />
                <span>{restartPending ? "Restart requested" : armed && interrupts ? "Restart anyway" : "Restart now"}</span>
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>

      {dismissed ? (
        <button
          type="button"
          aria-label="Restart required: show details"
          data-testid="dev-restart-tab"
          onClick={() => {
            haptic("tick");
            setDismissed(false);
          }}
          className="fixed top-(--pct-50) right-0 z-30 flex size-11 -translate-y-1/2 items-center justify-center rounded-l-full border border-r-0 border-amber-500 bg-amber-400 text-amber-950 shadow-lg"
        >
          <RotateCcw className="size-4" />
        </button>
      ) : null}
    </>
  );
}
