import { useQueries, useQuery } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, Wallet } from "lucide-react";
import type { AiConnectionBalance, AiManagedConnectionSummary } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { budgetsApi } from "@/api/budgets";
import { ModelLogo } from "@/components/ModelLogo";
import { formatUsd } from "@/components/api-keys/KeyBalance";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Skeleton } from "@/components/ui/skeleton";
import type { ModelProvider } from "@/lib/model-brand";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

/** At most this many keys get a balance check each time the sheet opens. */
const MAX_CHECKED = 6;

/**
 * The profile sheet's money card: what is left on each AI key (when the
 * provider reports it), what Automa spent this month, and the monthly limit.
 */
export function AccountBalanceCard({ companyId, open, onNavigate }: { companyId: string; open: boolean; onNavigate: () => void }) {
  const list = useQuery({
    queryKey: ["ai-connections", companyId],
    queryFn: () => aiConnectionsApi.list(companyId),
    enabled: open,
    staleTime: 60_000,
  });
  const connections: AiManagedConnectionSummary[] = (list.data?.connections ?? []).slice(0, MAX_CHECKED);
  const balances = useQueries({
    queries: connections.map((connection) => ({
      queryKey: ["ai-connection-balance", companyId, connection.id],
      queryFn: () => aiConnectionsApi.balance(companyId, connection.id),
      enabled: open,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const budget = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
    enabled: open,
  });
  const policy = budget.data?.policies.find(
    (item) => item.scopeType === "company" && item.scopeId === companyId && item.windowKind === "calendar_month_utc" && item.isActive && item.amount > 0,
  );

  const loaded = balances.map((query) => query.data).filter((data): data is AiConnectionBalance => Boolean(data));
  const reported = loaded.filter((data) => data.remainingUsd !== null);
  const remaining = reported.reduce((sum, data) => sum + (data.remainingUsd ?? 0), 0);
  // Spend is per provider, so two keys of one provider count once.
  const spentByProvider = new Map(loaded.map((data) => [data.provider, data.spentThisMonthCents]));
  const spentCents = [...spentByProvider.values()].reduce((sum, cents) => sum + cents, 0);
  const checking = list.isPending || balances.some((query) => query.isPending);

  return (
    <section aria-label="Balance" className="rounded-xl border border-border bg-card p-3" data-slot="account-balance" data-testid="account-balance">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Wallet className="size-4 text-muted-foreground" aria-hidden="true" /> Balance
        </h2>
        <Link to="/company/settings/api-keys" onClick={onNavigate} className="inline-flex items-center gap-0.5 text-xs font-medium text-primary">
          Keys <ChevronRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>

      {list.isPending ? (
        <Skeleton className="mt-2 h-14 w-full" />
      ) : list.isError ? (
        <p className="mt-2 text-xs text-muted-foreground">Couldn&apos;t load your keys.</p>
      ) : connections.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Add an API key to see its balance and what Automa spends.{" "}
          <Link to="/company/settings/api-keys" onClick={onNavigate} className="font-medium text-primary">Add a key</Link>
        </p>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-muted px-3 py-2">
              <p className="text-xs text-muted-foreground">Left on your keys</p>
              <p className="font-display text-lg font-semibold tabular-nums" data-testid="account-balance-remaining">
                {checking && reported.length === 0 ? "…" : reported.length > 0 ? formatUsd(remaining) : "—"}
              </p>
            </div>
            <div className="rounded-lg bg-muted px-3 py-2">
              <p className="text-xs text-muted-foreground">Spent this month</p>
              <p className="font-display text-lg font-semibold tabular-nums" data-testid="account-balance-spent">
                {checking && loaded.length === 0 ? "…" : formatUsd(spentCents / 100)}
              </p>
            </div>
          </div>
          {policy ? (
            <div className="mt-2 flex flex-col gap-1">
              <ProgressBar
                label="Monthly spending limit"
                value={policy.amount > 0 ? policy.observedAmount / policy.amount : 0}
                valueText={`${formatUsd(policy.observedAmount / 100)} of ${formatUsd(policy.amount / 100)}`}
              />
              <p className="text-xs text-muted-foreground">
                {formatUsd(policy.observedAmount / 100)} of your {formatUsd(policy.amount / 100)} monthly limit
              </p>
            </div>
          ) : null}
          <ul className="mt-2 divide-y divide-border">
            {connections.map((connection, index) => {
              const data = balances[index]?.data;
              return (
                <li key={connection.id} className="flex items-center gap-2 py-1.5">
                  <ModelLogo provider={connection.provider as ModelProvider} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{connection.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {balances[index]?.isPending ? (
                      "Checking…"
                    ) : !data ? (
                      "Couldn't check"
                    ) : data.remainingUsd !== null ? (
                      <span className="font-medium text-foreground">{formatUsd(data.remainingUsd)} left</span>
                    ) : (
                      <a href={data.billingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary">
                        See balance <ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {loaded.some((data) => data.remainingUsd === null) ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Anthropic and OpenAI don&apos;t share a key&apos;s balance with apps, so Automa shows what it spent and links to the provider.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
