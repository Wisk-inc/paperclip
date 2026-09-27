import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
}

/**
 * A stat tile read top-down: what it is (label), how much (value), and the
 * context behind it. The number carries the weight; the icon stays a quiet
 * inline hint beside the label rather than a decorative badge. The whole
 * tile is one tap target when it links somewhere.
 */
export function MetricCard({ icon: Icon, value, label, description, to, onClick }: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div
      className={cn(
        "h-full rounded-lg border border-border bg-card px-4 py-3.5 transition-colors duration-150 sm:px-5 sm:py-4",
        isClickable && "cursor-pointer hover:bg-accent/50 active:bg-accent",
      )}
    >
      <p className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1.5 font-display text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
        {value}
      </p>
      {description && (
        <div className="mt-1 hidden text-xs text-muted-foreground sm:block">{description}</div>
      )}
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div className="h-full" onClick={onClick}>
        {inner}
      </div>
    );
  }

  return inner;
}
