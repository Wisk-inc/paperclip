import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge, Loader2 } from "lucide-react";
import { budgetsApi } from "@/api/budgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/progress-bar";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { queryKeys } from "@/lib/queryKeys";
import { formatUsd } from "./KeyBalance";

/** Dollars typed in the box, as whole cents; null when it isn't a number. */
export function parseDollars(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * The organization's monthly spending limit, where people look for it: next
 * to their keys. At the limit, agents and App Studio's AI stop (the company
 * budget's hard stop) and stay stopped until someone resumes them: a new
 * month alone does not, so a paused organization says so and offers Resume.
 */
export function SpendingLimitCard({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const overview = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
  });
  const policy = overview.data?.policies.find(
    (item) => item.scopeType === "company" && item.scopeId === companyId && item.windowKind === "calendar_month_utc",
  );
  const active = Boolean(policy?.isActive && policy.amount > 0);
  // Still paused from reaching the limit (a new month does not lift it by itself).
  const paused = Boolean(active && policy?.paused);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    // Saving the limit again under what is spent (a new month) resumes the organization.
    mutationFn: (input: { amount: number; resume?: boolean }) =>
      budgetsApi.upsertPolicy(companyId, {
        scopeType: "company",
        scopeId: companyId,
        amount: input.amount,
        windowKind: "calendar_month_utc",
        hardStopEnabled: true,
      }),
    onSuccess: async (_policy, input) => {
      haptic("success");
      setDraft("");
      pushToast({
        title: input.resume
          ? "Agents and App Studio can work again"
          : input.amount > 0
            ? `Limit set to ${formatUsd(input.amount / 100)} a month`
            : "Spending limit turned off",
        body: input.amount > 0 && !input.resume ? "Agents and App Studio stop when it is reached." : undefined,
        tone: "success",
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: ["budgets"] }),
        client.invalidateQueries({ queryKey: ["companies"] }),
      ]);
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn't change the limit", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });
  const cents = parseDollars(draft);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (cents === null || cents <= 0 || save.isPending) return;
    save.mutate({ amount: cents });
  };

  return (
    <section aria-label="Monthly spending limit" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" data-testid="spending-limit">
      <div className="flex items-center gap-2">
        <Gauge className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Monthly spending limit</h2>
      </div>
      {overview.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : active && policy ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm">
            <span className="font-semibold">{formatUsd(policy.observedAmount / 100)}</span>
            <span className="text-muted-foreground"> of {formatUsd(policy.amount / 100)} this month</span>
          </p>
          <ProgressBar label="Spent this month" value={policy.amount > 0 ? policy.observedAmount / policy.amount : 0} />
          <p className={policy.status === "hard_stop" || paused ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {policy.status === "hard_stop"
              ? "Limit reached: agents and App Studio's AI are paused. Raise it to keep going."
              : paused
                ? "Still paused since the limit was reached: a new month doesn't resume it by itself."
                : policy.status === "warning"
                  ? `Almost there: ${formatUsd(policy.remainingAmount / 100)} left this month.`
                  : "Agents and App Studio's AI stop when it is reached, so nothing overspends."}
          </p>
          {paused && policy.status !== "hard_stop" ? (
            <Button
              type="button"
              size="sm"
              className="self-start"
              disabled={save.isPending}
              onClick={() => save.mutate({ amount: policy.amount, resume: true })}
              data-testid="spending-limit-resume"
            >
              Resume
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No limit yet. Set one and agents and App Studio&apos;s AI stop when it is reached, so you never spend more than you planned.
        </p>
      )}
      <form onSubmit={submit} className="flex items-center gap-2">
        <Input
          inputMode="decimal"
          aria-label="Monthly limit in US dollars"
          placeholder={active && policy ? (policy.amount / 100).toFixed(2) : "e.g. 20"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="h-9 max-w-40"
        />
        <Button type="submit" size="sm" disabled={cents === null || cents <= 0 || save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null}
          {active ? "Change" : "Set limit"}
        </Button>
        {active ? (
          <Button type="button" variant="ghost" size="sm" disabled={save.isPending} onClick={() => save.mutate({ amount: 0 })}>
            Turn off
          </Button>
        ) : null}
      </form>
    </section>
  );
}
