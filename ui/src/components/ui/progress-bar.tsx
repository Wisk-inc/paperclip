import { cn } from "@/lib/utils";

interface ProgressBarProps {
  /** Read out by screen readers ("Starting your app"). */
  label: string;
  /** 0 to 1 when the amount done is known; left out, the bar sweeps. */
  value?: number | null;
  /** Spoken instead of the percentage, e.g. "Step 3 of 5". */
  valueText?: string;
  className?: string;
}

/**
 * A thin bar that fills as work gets done. When nobody knows how long the
 * work takes, a band sweeps across it instead, so a long wait still moves.
 */
export function ProgressBar({ label, value, valueText, className }: ProgressBarProps) {
  const known = typeof value === "number" && Number.isFinite(value);
  const percent = known ? Math.round(Math.min(1, Math.max(0, value)) * 100) : null;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={valueText}
      data-slot="progress-bar"
      data-indeterminate={known ? undefined : ""}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        data-slot="progress-fill"
        className={cn("absolute inset-y-0 left-0 rounded-full bg-primary", known ? "" : "w-2/5")}
        style={known ? { width: `${percent}%` } : undefined}
      />
    </div>
  );
}
