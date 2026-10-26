import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * An image in a chat reply that shows a shimmering skeleton while it loads and
 * fades in once ready — so a just-generated picture arrives smoothly instead of
 * popping in. Falls back to a muted tile if the image can't load.
 */
export function ChatImage({
  src,
  alt,
  className,
  imgClassName,
  onClick,
}: {
  src: string;
  alt?: string;
  className?: string;
  imgClassName?: string;
  onClick?: () => void;
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  return (
    <span className={cn("relative block overflow-hidden", state === "loading" && "skeleton-shimmer", className)}>
      {state === "error" ? (
        <span className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">Couldn’t load image</span>
      ) : (
        <img
          src={src}
          alt={alt ?? ""}
          loading="lazy"
          decoding="async"
          onLoad={() => setState("ready")}
          onError={() => setState("error")}
          onClick={onClick}
          className={cn(
            "transition-opacity duration-300",
            state === "ready" ? "opacity-100" : "opacity-0",
            onClick && "cursor-pointer",
            imgClassName,
          )}
        />
      )}
    </span>
  );
}
