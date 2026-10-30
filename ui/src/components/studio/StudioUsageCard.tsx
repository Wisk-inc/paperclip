import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Sparkles } from "lucide-react";
import { studioApi } from "@/api/studio";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { ModelLogo } from "@/components/ModelLogo";
import { modelDisplayName } from "@/lib/model-brand";
import { cn } from "@/lib/utils";
import { formatCostAndWorth, formatTokens, formatUsd } from "./studio-usage";

/**
 * The AI models App Studio used in the last 30 days, each with its maker's
 * logo, its tokens, its cost (Free on the free models) and what the same
 * tokens cost at paid list prices: the assistant, its teammates and code
 * suggestions together. Renders nothing before any use.
 */
export function StudioUsageCard({
  companyId,
  className,
  linkToStudio = false,
  limit = 6,
}: {
  companyId: string;
  className?: string;
  /** On the dashboard: a link through to App Studio. */
  linkToStudio?: boolean;
  limit?: number;
}) {
  const usage = useQuery({
    queryKey: queryKeys.studio.usage(companyId),
    queryFn: () => studioApi.usage(companyId),
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });
  const models = (usage.data?.models ?? []).filter((model) => model.inputTokens + model.outputTokens > 0);
  if (!models.length) return null;

  const tokens = models.reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0);
  const cents = models.reduce((sum, model) => sum + model.costCents, 0);
  // Rows from a server before 1.9.5 have no equivalent: their cost stands in.
  const worthCents = models.reduce((sum, model) => sum + (model.equivalentCents ?? model.costCents), 0);
  const free = models.filter((model) => model.provider === "free").reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0);
  const shown = models.slice(0, limit);

  return (
    <Card className={cn("gap-0 p-0", className)} data-testid="studio-usage-card">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Sparkles className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">App Studio AI · last 30 days</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {formatTokens(tokens)} <span className="text-sm font-normal text-muted-foreground">tokens</span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {models.length} {models.length === 1 ? "model" : "models"}
            {free ? ` · ${formatTokens(free)} on the free models` : ""}
            {cents > 0 ? ` · $${(cents / 100).toFixed(2)} spent` : " · $0.00 charged"}
            {worthCents > cents + 0.5 ? ` · worth ${formatUsd(worthCents / 100)} at paid prices` : ""}
          </div>
        </div>
        <div className="hidden -space-x-1.5 sm:flex" aria-hidden="true">
          {shown.map((model) => (
            <ModelLogo key={`${model.provider}:${model.model}`} modelId={model.model} size="md" className="ring-2 ring-card" />
          ))}
        </div>
      </div>
      <ul className="flex flex-col divide-y divide-border" aria-label="App Studio models">
        {shown.map((model) => {
          const spend = formatCostAndWorth({
            free: model.provider === "free",
            costUsd: model.costCents / 100,
            equivalentUsd: (model.equivalentCents ?? model.costCents) / 100,
          });
          const share = tokens ? Math.max(2, Math.round(((model.inputTokens + model.outputTokens) / tokens) * 100)) : 0;
          return (
            <li key={`${model.provider}:${model.model}`} className="flex items-center gap-3 px-4 py-2.5" data-testid="studio-usage-model">
              <ModelLogo modelId={model.model} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{modelDisplayName(model.model)}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatTokens(model.inputTokens)} in · {formatTokens(model.outputTokens)} out{spend ? ` · ${spend}` : ""}
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {models.length > shown.length || linkToStudio ? (
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>{models.length > shown.length ? `and ${models.length - shown.length} more` : ""}</span>
          {linkToStudio ? (
            <Link to="/studio" className="flex items-center gap-0.5 hover:text-foreground">
              Open App Studio <ChevronRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
