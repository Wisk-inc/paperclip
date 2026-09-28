import { ChevronRight } from "lucide-react";
import { haptic } from "@/lib/haptics";
import { SUPPORT_DISCORD_LOGO, SUPPORT_DISCORD_URL } from "@/lib/support";
import { cn } from "@/lib/utils";

interface DiscordSupportLinkProps {
  /** `icon`: the Discord logo alone (sidebar footer); `card`: a full-width row with a label (phone Home). */
  variant?: "icon" | "card";
  className?: string;
}

/**
 * Opens the Automa support server on Discord. In the Android app the link
 * leaves the app for the Discord app (or the browser when Discord is not
 * installed), like every other outside link.
 */
export function DiscordSupportLink({ variant = "icon", className }: DiscordSupportLinkProps) {
  const logo = <img src={SUPPORT_DISCORD_LOGO} alt="" draggable={false} className="size-full object-contain" />;
  if (variant === "card") {
    return (
      <a
        href={SUPPORT_DISCORD_URL}
        target="_blank"
        rel="noreferrer"
        data-slot="discord-support"
        onClick={() => haptic("tick")}
        className={cn(
          "flex min-h-14 items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/60 active:bg-accent",
          className,
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background p-1.5">{logo}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Get help on Discord</span>
          <span className="block truncate text-xs text-muted-foreground">Ask questions, share ideas, meet other Automa builders</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </a>
    );
  }
  return (
    <a
      href={SUPPORT_DISCORD_URL}
      target="_blank"
      rel="noreferrer"
      data-slot="discord-support"
      aria-label="Get help on Discord"
      title="Get help on Discord"
      onClick={() => haptic("tick")}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg p-1.5 transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {logo}
    </a>
  );
}
