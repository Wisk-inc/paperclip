import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { Mascot } from "./mascot/Mascot";
import { automaNative, isAutomaApp } from "@/lib/automa-native";

/**
 * Shown when this Automa is locked to the Automa app
 * (PAPERCLIP_LOCAL_TRUSTED_SECRET) and the page arrived without the app's
 * key: a browser on the phone, or the app before Termux handed the key over.
 *
 * Inside the app this is a moment, not a wall: the app is told at once, tries
 * the keys it holds against the server and reloads, or moves to its connect
 * screen with instructions. The copy below is for the seconds in between, and
 * for an app too old to know the call.
 */
export function LocalSecretNotice() {
  const inApp = isAutomaApp();
  const [asked, setAsked] = useState<"idle" | "asked" | "unsupported">("idle");
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!inApp) return;
    setAsked(automaNative.appKeyMissing() ? "asked" : "unsupported");
    const timer = window.setTimeout(() => setSlow(true), 6000);
    return () => window.clearTimeout(timer);
  }, [inApp]);

  if (inApp && asked === "asked" && !slow) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="local-secret-notice">
        <Mascot pose="thinking" size="md" />
        <p className="text-lg font-semibold">Getting Automa's key…</p>
        <p className="max-w-sm text-sm text-muted-foreground">The app is handing its key to Automa on this phone. One moment.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="local-secret-notice">
      <Mascot pose="confused" size="md" />
      <p className="text-lg font-semibold">This Automa only answers the Automa app</p>
      {inApp ? (
        <p className="max-w-sm text-sm text-muted-foreground">
          The app does not have this Automa's key yet. Open Termux and run <code className="font-mono">automa link</code>: it
          opens Automa here with the key. You can also paste the key it prints on the connect screen.
        </p>
      ) : (
        <p className="max-w-sm text-sm text-muted-foreground">
          It runs on this phone and is locked to the app, so other apps and browsers can't use it. Open it in the Automa app.
          If the app can't get in, run <code className="font-mono">automa link</code> in Termux to hand it the key again.
        </p>
      )}
      {inApp ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            onClick={() => {
              setSlow(false);
              setAsked(automaNative.appKeyMissing() ? "asked" : "unsupported");
              window.setTimeout(() => setSlow(true), 6000);
            }}
          >
            Try again
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-2 text-sm font-medium"
            onClick={() => automaNative.openConnectScreen()}
          >
            Connect screen
          </button>
        </div>
      ) : null}
      <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Smartphone className="size-3.5" /> Locked to the Automa app on this phone
      </p>
    </div>
  );
}
