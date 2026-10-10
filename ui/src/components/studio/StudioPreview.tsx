import { useState } from "react";
import { Check, Copy, ExternalLink, Globe, LoaderCircle, Play, RefreshCw, Rocket, SquareTerminal, X } from "lucide-react";
import type { StudioRunState } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";
import { Mascot } from "../mascot/Mascot";

interface StudioPreviewProps {
  run: StudioRunState | null;
  /** Prints to the console rather than serving pages. */
  consoleApp: boolean;
  /** Absent for collaborators, who can't start the app. */
  onRun?: () => void;
  onShowConsole: () => void;
  /** Public links are for the owner only. */
  publicLink?: {
    cloudflaredInstalled: boolean;
    onOpen: () => Promise<void>;
    onClose: () => Promise<void>;
    onInstall: () => Promise<void>;
  };
}

/**
 * The running app, inside Automa. Pages load in a sandbox (they can't act
 * as you in Automa). The owner can also open a public Cloudflare link that
 * points at this app's own port, served from this device.
 */
export function StudioPreview({ run, consoleApp, onRun, onShowConsole, publicLink }: StudioPreviewProps) {
  const [frameKey, setFrameKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [working, setWorking] = useState<"open" | "close" | "install" | null>(null);
  const running = run?.status === "running" || run?.status === "starting";
  const previewUrl = run?.previewReady && run.previewPath ? run.previewPath : null;

  const act = async (kind: "open" | "close" | "install", action: () => Promise<void>) => {
    setWorking(kind);
    try {
      await action();
    } finally {
      setWorking(null);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      haptic("success");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked; the link is still selectable
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" data-testid="studio-preview-address">
          {previewUrl ? `localhost:${run?.port}` : running ? "waiting for your app…" : "not running"}
        </span>
        {previewUrl ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Reload preview" onClick={() => setFrameKey((key) => key + 1)}>
              <RefreshCw />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Open preview in a new tab" asChild>
              <a href={previewUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
              </a>
            </Button>
          </>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1 bg-background">
        {previewUrl ? (
          <iframe
            key={`${previewUrl}:${frameKey}`}
            src={previewUrl}
            title="App preview"
            data-testid="studio-preview-frame"
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
            className="size-full border-0 bg-background"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            {running && !consoleApp ? (
              <>
                <Mascot pose="thinking" size="sm" />
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" /> Starting your app. The preview opens when it answers.
                </p>
                <Button variant="outline" size="sm" onClick={onShowConsole}>
                  <SquareTerminal /> Watch the console
                </Button>
              </>
            ) : consoleApp ? (
              <>
                <Mascot pose="thinking" size="sm" gaze="down" />
                <p className="max-w-xs text-sm text-muted-foreground">This app prints to the console. Run it and read its output there.</p>
                <div className="flex gap-2">
                  {onRun ? (
                    <Button size="sm" onClick={onRun}>
                      <Play /> Run
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={onShowConsole}>
                    Console
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Mascot pose="idle" size="sm" gaze="down" />
                <p className="max-w-xs text-sm text-muted-foreground">{onRun ? "Run your app to see it here." : "The preview shows up here when the owner runs the app."}</p>
                {onRun ? (
                  <Button size="sm" onClick={onRun}>
                    <Play /> Run
                  </Button>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>

      {publicLink && !consoleApp ? (
        <div className="flex flex-col gap-2 border-t border-border p-3" data-testid="studio-public-link">
          {run?.publicUrl ? (
            <>
              <p className="text-xs text-muted-foreground">Anyone with this link can open your app while it runs on this device.</p>
              <div className="flex items-center gap-1">
                <a href={run.publicUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-sm text-primary underline-offset-2 hover:underline">
                  {run.publicUrl}
                </a>
                <Button variant="ghost" size="icon-sm" aria-label="Copy public link" onClick={() => void copy(run.publicUrl!)}>
                  {copied ? <Check /> : <Copy />}
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Close public link" disabled={working === "close"} onClick={() => void act("close", publicLink.onClose)}>
                  <X />
                </Button>
              </div>
            </>
          ) : publicLink.cloudflaredInstalled ? (
            <>
              <Button variant="outline" disabled={working === "open" || run?.tunnelStatus === "starting"} onClick={() => void act("open", publicLink.onOpen)}>
                {working === "open" || run?.tunnelStatus === "starting" ? <LoaderCircle className="animate-spin" /> : <Rocket />}
                Get a public link
              </Button>
              <p className="text-xs text-muted-foreground">A free Cloudflare link to this app, hosted from this device. It ends when the app stops.</p>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={working === "install"} onClick={() => void act("install", publicLink.onInstall)}>
                {working === "install" ? <LoaderCircle className="animate-spin" /> : <Rocket />}
                Set up public links
              </Button>
              <p className="text-xs text-muted-foreground">Installs Cloudflare's free tunnel (cloudflared) so you can share a link to your running app.</p>
            </>
          )}
          {run?.tunnelError && run.tunnelStatus !== "on" ? <p className="text-xs text-destructive">{run.tunnelError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
