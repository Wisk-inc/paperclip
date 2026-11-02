import { useMemo, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** Dollars typed by a person, in cents; null when it isn't an amount. */
export function parseBudgetDollars(value: string): number | null {
  const normalized = value.trim().replace(/^\$/, "");
  if (normalized.length === 0) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100);
}

/**
 * Gives an agent a monthly budget (a hard stop, by UTC month). Agents that
 * already have one are edited on their card below; this lists the others.
 */
export function AgentBudgetForm({
  agents,
  budgetedAgentIds,
  isSaving,
  onSave,
  initialAgentId,
}: {
  agents: Agent[];
  budgetedAgentIds: ReadonlySet<string>;
  isSaving: boolean;
  onSave: (agentId: string, amountCents: number) => void;
  /** Starts on this agent (the page was opened for it). */
  initialAgentId?: string;
}) {
  const choices = useMemo(
    () =>
      agents
        .filter((agent) => agent.status !== "terminated" && !budgetedAgentIds.has(agent.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [agents, budgetedAgentIds],
  );
  const [agentId, setAgentId] = useState(initialAgentId ?? "");
  const [dollars, setDollars] = useState("");
  const chosen = choices.find((agent) => agent.id === agentId) ?? null;
  const amount = parseBudgetDollars(dollars);

  if (choices.length === 0) return null;

  return (
    <Card data-testid="agent-budget-form">
      <CardHeader className="px-5 pt-5 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="size-4 text-muted-foreground" aria-hidden="true" /> Add an agent budget
        </CardTitle>
        <CardDescription>
          A monthly limit for one agent. When it is used up the agent pauses until you raise it or the month ends (UTC).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-5 pb-5 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Agent
          <select
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            aria-label="Agent"
          >
            <option value="">Choose an agent…</option>
            {choices.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:w-40">
          Monthly budget (USD)
          <Input
            inputMode="decimal"
            placeholder="25.00"
            value={dollars}
            onChange={(event) => setDollars(event.target.value)}
            aria-label="Monthly budget in dollars"
          />
        </label>
        <Button
          disabled={!chosen || amount === null || isSaving}
          onClick={() => {
            if (!chosen || amount === null) return;
            onSave(chosen.id, amount);
            setAgentId("");
            setDollars("");
          }}
        >
          Set budget
        </Button>
      </CardContent>
    </Card>
  );
}
