import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Wallet } from "lucide-react";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";

export function formatUsd(dollars: number) {
  return dollars.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Under a key: what is left on its account (when the provider says), what
 * Automa spent on its provider this month, with a link to top up, and why
 * there is no balance when the provider gives none. The spend is the whole
 * organization's for the provider: App Studio records no key with its costs,
 * so it is shown as that, not as this key's.
 */
export function KeyBalance({
  companyId,
  connection,
  providerLabel,
}: {
  companyId: string;
  connection: AiManagedConnectionSummary;
  providerLabel: string;
}) {
  const balance = useQuery({
    queryKey: ["ai-connection-balance", companyId, connection.id],
    queryFn: () => aiConnectionsApi.balance(companyId, connection.id),
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (balance.isPending) {
    return <p className="text-xs text-muted-foreground" data-testid="api-key-balance">Checking the balance…</p>;
  }
  if (balance.isError || !balance.data) {
    return <p className="text-xs text-muted-foreground" data-testid="api-key-balance">Couldn&apos;t check the balance.</p>;
  }
  const data = balance.data;
  const spent = formatUsd(data.spentThisMonthCents / 100);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="api-key-balance">
      {data.remainingUsd !== null ? (
        <span className="flex items-center gap-1 font-medium text-foreground">
          <Wallet className="size-3.5" aria-hidden="true" />
          {formatUsd(data.remainingUsd)} left
        </span>
      ) : null}
      <span>
        {providerLabel} use this month, all keys: {spent}
      </span>
      <a href={data.billingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
        {data.remainingUsd !== null ? "Add credit" : "Balance"}
        <ExternalLink className="size-3" aria-hidden="true" />
      </a>
      {data.note ? (
        <span className="basis-full" data-testid="api-key-balance-note">
          {data.note}
        </span>
      ) : null}
    </div>
  );
}
