import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { refreshBoard } from "../lib/board-refresh";
import { haptic } from "../lib/haptics";
import { cn } from "../lib/utils";

/** The shortest turn the icon makes, so a quick refresh still shows it happened. */
const MIN_SPIN_MS = 570;

/**
 * Refresh in the header: everything on the page loads again from the server,
 * and the live updates reconnect (on a phone that slept, a connection can look
 * open and bring nothing). For a board that looks stuck or out of date; what
 * was typed stays, since the page itself is not reloaded.
 */
export function RefreshButton({ className }: { className?: string }) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = () => {
    if (refreshing) return;
    haptic("tick");
    setRefreshing(true);
    const started = Date.now();
    void refreshBoard(queryClient).finally(() => {
      const rest = Math.max(0, MIN_SPIN_MS - (Date.now() - started));
      window.setTimeout(() => {
        if (mounted.current) setRefreshing(false);
      }, rest);
    });
  };

  return (
    <button
      type="button"
      onClick={refresh}
      aria-label={refreshing ? "Refreshing" : "Refresh"}
      aria-busy={refreshing}
      title="Refresh"
      data-slot="refresh-button"
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent",
        className,
      )}
    >
      <RefreshCw className={cn("size-5", refreshing && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
    </button>
  );
}
