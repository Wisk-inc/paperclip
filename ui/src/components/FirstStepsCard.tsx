import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight } from "lucide-react";
import { aiConnectionsApi } from "@/api/ai-connections";
import { ProgressBar } from "@/components/ui/progress-bar";
import { featureTourSeen, requestFeatureTour } from "@/lib/feature-tour";
import { haptic } from "@/lib/haptics";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

interface FirstStep {
  id: string;
  label: string;
  hint: string;
  done: boolean;
  to?: string;
  onClick?: () => void;
}

/**
 * A new organization's Home: the steps that get it working, each ticked off
 * from what is really there (a key, an agent, a task, a limit), instead of
 * empty charts and zeros.
 */
export function FirstStepsCard({
  companyId,
  agentCount,
  taskCount,
  budgetCents,
}: {
  companyId: string;
  agentCount: number;
  taskCount: number;
  budgetCents: number;
}) {
  const keys = useQuery({
    queryKey: ["ai-connections", companyId],
    queryFn: () => aiConnectionsApi.list(companyId),
  });
  const hasKey = (keys.data?.connections ?? []).some((connection) => connection.status !== "revoked");
  const steps: FirstStep[] = [
    { id: "key", label: "Add an API key", hint: "Agents, chats and App Studio run on it.", done: hasKey, to: "/company/settings/api-keys" },
    { id: "agent", label: "Hire your first agent", hint: "Give it a name, a role and a model.", done: agentCount > 0, to: "/agents" },
    { id: "task", label: "Give it something to do", hint: "Say it in Chats; it becomes a task.", done: taskCount > 0, to: "/chats" },
    { id: "limit", label: "Set a monthly spending limit", hint: "Agents stop at it, so nothing overspends.", done: budgetCents > 0, to: "/company/settings/api-keys" },
    {
      id: "tour",
      label: "Take the tour",
      hint: "Two minutes on every part of Automa.",
      done: featureTourSeen(),
      onClick: () => {
        haptic("tick");
        requestFeatureTour();
      },
    },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  return (
    <section aria-label="First steps" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" data-testid="first-steps">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">First steps</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {doneCount} of {steps.length} done
        </span>
      </div>
      <ProgressBar label="First steps done" value={doneCount / steps.length} valueText={`${doneCount} of ${steps.length} done`} />
      <ol className="flex flex-col divide-y divide-border">
        {steps.map((step) => {
          const body = (
            <>
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                  step.done ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {step.done ? <Check className="size-3.5" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm font-medium", step.done && "text-muted-foreground line-through")}>{step.label}</span>
                <span className="block text-xs text-muted-foreground">{step.hint}</span>
              </span>
              {step.done ? null : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            </>
          );
          const rowClass = "flex min-h-12 w-full items-center gap-3 py-2 text-left";
          return (
            <li key={step.id} data-step={step.id} data-done={step.done || undefined}>
              {step.to ? (
                <Link to={step.to} className={cn(rowClass, "no-underline text-inherit")}>
                  {body}
                </Link>
              ) : (
                <button type="button" className={rowClass} onClick={step.onClick}>
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
