import { appearanceForPalette } from "@paperclipai/shared";
import { AgentAvatar } from "../AgentAvatar";
import { cn } from "@/lib/utils";

const LOGOS = [
  { src: "/brands/apps/gmail.svg", className: "left-3 bottom-5 -rotate-12" },
  { src: "/brands/apps/notion.svg", className: "left-14 bottom-2 rotate-6" },
  { src: "/brands/apps/google-drive.svg", className: "left-6 top-5 rotate-3" },
  { src: "/brands/apps/github.svg", className: "right-14 bottom-3 -rotate-6" },
  { src: "/brands/apps/linear.svg", className: "right-3 bottom-8 rotate-12" },
  { src: "/brands/apps/slack.svg", className: "right-7 top-4 -rotate-3" },
] as const;

/**
 * Two Paperclip agent characters surrounded by the apps they can reach, built
 * from the shipped character art and brand logos (the same scene as the
 * connectors launch artwork), so it stays available after that announcement
 * is dismissed and follows the theme.
 */
export function ConnectorsIllustration({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("relative flex h-44 w-full items-end justify-center overflow-hidden rounded-lg bg-muted", className)}
    >
      <AgentAvatar appearance={appearanceForPalette("turquoise-cherry")} size={128} pose="success" className="-mb-3" />
      <AgentAvatar appearance={appearanceForPalette("pink-lemonade")} size={96} pose="idle" className="-mb-2 -ml-5" />
      {LOGOS.map((logo) => (
        <span
          key={logo.src}
          className={cn(
            "absolute flex size-11 items-center justify-center rounded-lg bg-white shadow-sm ring-1 ring-black/5",
            logo.className,
          )}
        >
          <img src={logo.src} alt="" className="size-6" loading="lazy" decoding="async" />
        </span>
      ))}
    </div>
  );
}
