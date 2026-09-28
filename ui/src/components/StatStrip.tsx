import { cn } from "@/lib/utils";

export interface StatTile {
  label: string;
  value: number | string;
  /** `working` highlights live activity; `attention` marks something that needs a person. */
  tone?: "default" | "working" | "attention";
}

const TONE_CLASS: Record<NonNullable<StatTile["tone"]>, string> = {
  default: "text-foreground",
  working: "text-amber-600 dark:text-amber-400",
  attention: "text-destructive",
};

/**
 * At-a-glance counts for a list page on phones: one row of compact tiles
 * above the list, so a short list does not leave the screen empty and the
 * person sees the shape of the work before reading rows. Hidden from md up,
 * where the list's own columns carry this.
 */
export function StatStrip({ tiles, className }: { tiles: StatTile[]; className?: string }) {
  return (
    <ul className={cn("grid grid-cols-4 gap-2 md:hidden", className)} aria-label="Summary">
      {tiles.map((tile) => (
        <li key={tile.label} className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2">
          <span className={cn("font-display text-lg font-semibold leading-none tabular-nums", TONE_CLASS[tile.tone ?? "default"])}>
            {tile.value}
          </span>
          <span className="truncate text-xs text-muted-foreground">{tile.label}</span>
        </li>
      ))}
    </ul>
  );
}
