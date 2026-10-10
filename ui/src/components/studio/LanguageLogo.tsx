import { useState } from "react";
import { STUDIO_DARK_LOGOS, STUDIO_DIM_LOGOS, studioLanguageLogoUrl } from "@/lib/studio-language-logos";
import { cn } from "@/lib/utils";

/** Whether a `#rrggbb` color is light enough to need dark text on it. */
export function isLightColor(color: string): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return false;
  const value = parseInt(match[1]!, 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.3;
}

const SIZES = {
  sm: { tile: "size-6 rounded-md p-0.5", text: "text-(length:--text-nano)" },
  md: { tile: "size-10 rounded-lg p-1.5", text: "text-xs" },
  lg: { tile: "size-12 rounded-xl p-2", text: "text-sm" },
  xl: { tile: "size-16 rounded-2xl p-2.5", text: "text-base" },
} as const;

interface LanguageLogoProps {
  language: { id: string; abbr: string; color: string; name: string };
  size?: keyof typeof SIZES;
  className?: string;
}

/**
 * A language's logo on a soft tile (dark in dark mode; black marks flip to
 * white there), or, without a logo, its abbreviation on its brand color.
 */
export function LanguageLogo({ language, size = "md", className }: LanguageLogoProps) {
  const url = studioLanguageLogoUrl(language.id);
  const [failed, setFailed] = useState(false);
  const { tile, text } = SIZES[size];
  if (url && !failed) {
    return (
      <span
        data-slot="language-logo"
        className={cn("flex shrink-0 items-center justify-center bg-studio-logo-tile shadow-sm ring-1 ring-border", tile, className)}
        title={language.name}
      >
        <img
          src={url}
          alt=""
          aria-hidden="true"
          className={cn(
            "size-full object-contain",
            STUDIO_DARK_LOGOS.has(language.id) && "dark:invert",
            STUDIO_DIM_LOGOS.has(language.id) && "dark:brightness-150",
          )}
          draggable={false}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      data-slot="language-logo"
      aria-hidden="true"
      title={language.name}
      className={cn(
        "flex shrink-0 items-center justify-center font-mono font-bold shadow-sm",
        tile,
        text,
        isLightColor(language.color) ? "text-studio-badge-foreground-dark" : "text-studio-badge-foreground",
        className,
      )}
      style={{ backgroundImage: `linear-gradient(135deg, ${language.color}, color-mix(in oklch, ${language.color} 70%, black))` }}
    >
      {language.abbr}
    </span>
  );
}
