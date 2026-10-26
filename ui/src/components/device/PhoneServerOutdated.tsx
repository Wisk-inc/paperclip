import { ArrowUpCircle, Loader2, RefreshCw, TerminalSquare } from "lucide-react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Mascot } from "@/components/mascot/Mascot";
import { automaNative, isAutomaApp } from "@/lib/automa-native";
import { copyTextToClipboard } from "@/lib/clipboard";
import { haptic } from "@/lib/haptics";
import { useToastActions } from "@/context/ToastContext";

/** The command that updates the Automa server in Termux from the app's bundle. */
const UPDATE_COMMAND = "pkg update -y && tar -xf ~/downloads/automa-server.tar.xz -C $TMPDIR && bash $TMPDIR/automa-server/install.sh";

/**
 * True when an error means the Automa server on this phone is older than the
 * app: the route does not exist, so the server replies 404. (A current server
 * that simply refuses a non-operator replies 403.)
 */
export function isServerTooOld(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * Shown when a device-only feature (Terminals, App Inspector) can't reach its
 * routes because the phone's Automa server predates them. Installing a new app
 * does not update the server running in Termux — this says how to update it.
 */
export function PhoneServerOutdated({ feature, onRetry }: { feature: string; onRetry?: () => void }) {
  const { pushToast } = useToastActions();
  const inApp = isAutomaApp();

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" data-testid="server-outdated">
      <div className="flex items-start gap-3">
        <Mascot pose="thinking" size="sm" />
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <ArrowUpCircle className="size-4 text-primary" aria-hidden="true" /> Update Automa on this phone
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {feature} is new in this version of the app, but the Automa server running on this phone is older and doesn&apos;t have it yet.
            Installing the app doesn&apos;t update that server — update it once and {feature} works.
          </p>
        </div>
      </div>

      {inApp ? (
        <>
          <Button
            onClick={() => {
              haptic("tick");
              automaNative.openConnectScreen();
            }}
            data-testid="server-outdated-update"
          >
            <ArrowUpCircle /> Update Automa on this phone
          </Button>
          <p className="text-xs text-muted-foreground">
            On the setup screen, tap <b>Send to Termux</b>, then paste the command it gives you in Termux. Updates are much faster than the
            first install.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">In Termux on the phone, send the new server from the app&apos;s setup screen, then run:</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-3 py-2 font-mono text-(length:--text-micro)">{UPDATE_COMMAND}</code>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Copy the update command"
              onClick={() => {
                void copyTextToClipboard(UPDATE_COMMAND).then(() => pushToast({ title: "Command copied", tone: "success" }));
              }}
            >
              <TerminalSquare />
            </Button>
          </div>
        </>
      )}

      {onRetry ? (
        <Button variant="ghost" size="sm" className="self-start" onClick={onRetry} data-testid="server-outdated-retry">
          <RefreshCw /> Check again
        </Button>
      ) : null}
    </div>
  );
}

/** Convenience: a spinner while a status loads, the outdated panel on a 404, null otherwise. */
export function DeviceFeatureGate({
  feature,
  pending,
  error,
  onRetry,
}: {
  feature: string;
  pending: boolean;
  error: unknown;
  onRetry?: () => void;
}) {
  if (pending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking this phone…
      </p>
    );
  }
  if (isServerTooOld(error)) return <PhoneServerOutdated feature={feature} onRetry={onRetry} />;
  return null;
}
