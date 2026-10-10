import { Smartphone } from "lucide-react";
import { Mascot } from "./mascot/Mascot";

/**
 * Shown when this Automa is locked to the Automa app
 * (PAPERCLIP_LOCAL_TRUSTED_SECRET) and the page arrived without the app's
 * key: a browser on the phone, or the app before Termux handed the key over.
 */
export function LocalSecretNotice() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="local-secret-notice">
      <Mascot pose="confused" size="md" />
      <p className="text-lg font-semibold">This Automa only answers the Automa app</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        It runs on this phone and is locked to the app, so other apps and browsers can't use it. Open it in the Automa app.
        If the app can't get in, run <code className="font-mono">automa link</code> in Termux to hand it the key again.
      </p>
      <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Smartphone className="size-3.5" /> Locked to the Automa app on this phone
      </p>
    </div>
  );
}
