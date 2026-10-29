import { useQuery } from "@tanstack/react-query";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { Gauge } from "lucide-react";
import { costsApi } from "@/api/costs";
import { Card } from "@/components/ui/card";
import { queryKeys } from "@/lib/queryKeys";
import { cn, providerDisplayName } from "@/lib/utils";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When a limit resets, the way Claude says it: a countdown within a day, else the day. */
export function resetLabel(resetsAt: string, now = Date.now()): string | null {
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  const left = at - now;
  if (left <= MINUTE) return "Resets in under a minute";
  if (left < DAY) {
    const hours = Math.floor(left / HOUR);
    const minutes = Math.round((left % HOUR) / MINUTE);
    if (hours === 0) return `Resets in ${minutes} min`;
    return minutes ? `Resets in ${hours} h ${minutes} min` : `Resets in ${hours} h`;
  }
  const date = new Date(at);
  if (left < 7 * DAY) {
    return `Resets ${date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  }
  return `Resets ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function fillClass(usedPercent: number): string {
  if (usedPercent >= 90) return "bg-destructive";
  if (usedPercent >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

/** Free models first (every Automa user has them), then the rest by name. */
function providerOrder(a: ProviderQuotaResult, b: ProviderQuotaResult): number {
  if (a.provider === "free_models") return -1;
  if (b.provider === "free_models") return 1;
  return providerDisplayName(a.provider).localeCompare(providerDisplayName(b.provider));
}

function LimitRow({ window, now }: { window: QuotaWindow; now: number }) {
  const percent = window.usedPercent == null ? null : Math.min(100, Math.max(0, window.usedPercent));
  const reset = window.resetsAt ? resetLabel(window.resetsAt, now) : null;
  const sub = [window.valueLabel, reset].filter(Boolean).join(" · ");
  return (
    <div className="space-y-1.5" data-testid="usage-limit">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium">{window.label}</span>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
          {percent == null ? window.valueLabel : `${Math.round(percent)}% used`}
        </span>
      </div>
      {percent == null ? null : (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`${window.label}: ${Math.round(percent)}% used`}
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={cn("h-full rounded-full transition-(--tp-width) duration-200", fillClass(percent))} style={{ width: `${percent}%` }} />
        </div>
      )}
      {percent != null && sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      {window.detail ? <p className="text-xs text-muted-foreground">{window.detail}</p> : null}
    </div>
  );
}

/**
 * How much of each usage limit is used and when it resets: the free models'
 * monthly allowance and daily limits, and any subscription a provider
 * reports (Claude's session and weekly limits). Hidden when no provider
 * reports a limit.
 */
export function UsageLimitsCard({ companyId, className }: { companyId: string; className?: string }) {
  const quotas = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    refetchInterval: MINUTE,
    staleTime: 30_000,
  });
  const results = (quotas.data ?? []).filter((result) => result.ok && result.windows.length > 0).sort(providerOrder);
  const failed = (quotas.data ?? []).filter((result) => !result.ok && result.provider === "free_models");
  if (results.length === 0 && failed.length === 0) return null;
  const now = quotas.dataUpdatedAt || Date.now();

  return (
    <Card className={className} data-testid="usage-limits">
      <div className="space-y-5 p-4">
        <div className="flex items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Usage limits</h2>
        </div>
        {results.map((result) => (
          <section key={result.provider} className="space-y-4" aria-label={providerDisplayName(result.provider)}>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
              {providerDisplayName(result.provider)}
            </div>
            {result.windows.map((window) => (
              <LimitRow key={window.label} window={window} now={now} />
            ))}
          </section>
        ))}
        {failed.map((result) => (
          <p key={result.provider} className="text-xs text-destructive" role="alert">{result.error}</p>
        ))}
      </div>
    </Card>
  );
}
