import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Issue, IssueWorkMode } from "@paperclipai/shared";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { costsApi } from "@/api/costs";
import { issuesApi } from "@/api/issues";
import { workModeMetaFor } from "@/lib/work-mode-meta";
import { modelDisplayName, type ModelProvider } from "@/lib/model-brand";
import { ModelLogo } from "@/components/ModelLogo";
import { CHAT_SLASH_COMMANDS } from "@/components/task-chat/slash-commands";

const SHEET_CLASS =
  "max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-xl md:-translate-x-1/2";

/** `/help`: every slash command the composer understands here. */
export function SlashHelpSheet({
  open,
  onOpenChange,
  conversationMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationMode: boolean;
}) {
  const rows = [
    ...(conversationMode
      ? [{ command: "new", name: "New session", description: "Fresh context for the agent; the conversation stays.", example: "/new" }]
      : [{ command: "goal", name: "Goal", description: "Pursue work across turns on this task.", example: "/goal ship the login page" }]),
    ...CHAT_SLASH_COMMANDS.filter((spec) => conversationMode || !spec.conversationOnly),
  ];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className={SHEET_CLASS} data-testid="slash-help-sheet">
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
        <SheetHeader className="gap-1 px-4 pt-3 pb-2">
          <SheetTitle className="text-base">Slash commands</SheetTitle>
          <SheetDescription className="text-xs">
            Type <span className="font-mono text-foreground">/</span> in the message box to see these as you type; Enter runs the one you picked.
          </SheetDescription>
        </SheetHeader>
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain border-t border-border pb-4">
          {rows.map((row) => (
            <li key={row.command} className="flex items-start gap-3 px-4 py-3">
              <code className="mt-0.5 shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">/{row.command}</code>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{row.name}</p>
                <p className="text-xs text-muted-foreground">{row.description}</p>
                {"example" in row && row.example ? (
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{row.example}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents >= 1000 ? 0 : 2)}`;
}

/** Start of the current month, for this month's spend and tokens. */
function monthStartIso(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

/**
 * `/context`: what this agent is working with. Model and mode come from the
 * agent and the chat; tokens and spend are this month's totals for the agent
 * from the cost ledger, per model, so a model switch shows up as its own row.
 */
export function ChatContextSheet({
  open,
  onOpenChange,
  agent,
  issue,
  workMode,
  messageCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  issue: Issue | null;
  workMode: IssueWorkMode;
  messageCount: number | null;
}) {
  const model = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const from = monthStartIso();
  const byModel = useQuery({
    queryKey: ["chat-context", "costs-by-agent-model", agent.companyId, from],
    queryFn: () => costsApi.byAgentModel(agent.companyId, from),
    enabled: open,
    staleTime: 60_000,
  });
  const comments = useQuery({
    queryKey: ["chat-context", "comments", issue?.id ?? "none"],
    queryFn: () => issuesApi.listComments(issue!.id),
    enabled: open && Boolean(issue?.id) && messageCount === null,
    staleTime: 30_000,
  });
  const rows = useMemo(
    () => (byModel.data ?? []).filter((row) => row.agentId === agent.id).sort((a, b) => b.costCents - a.costCents),
    [byModel.data, agent.id],
  );
  const totals = rows.reduce(
    (acc, row) => ({
      input: acc.input + row.inputTokens + (row.cachedInputTokens ?? 0),
      output: acc.output + row.outputTokens,
      cents: acc.cents + row.costCents,
    }),
    { input: 0, output: 0, cents: 0 },
  );
  const count = messageCount ?? (Array.isArray(comments.data) ? comments.data.length : null);
  const mode = workModeMetaFor(workMode);
  const usage = (value: string) => (byModel.isPending ? "…" : byModel.isError ? "—" : value);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className={SHEET_CLASS} data-testid="chat-context-sheet">
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
        <SheetHeader className="gap-1 px-4 pt-3 pb-2">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ModelLogo modelId={model} adapterType={agent.adapterType} size="sm" />
            Context for {agent.name}
          </SheetTitle>
          <SheetDescription className="text-xs">What the agent is answering with right now, and what this month has cost.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border px-4 pt-3 pb-5">
          <dl className="grid grid-cols-2 gap-2">
            <Stat label="Model" value={model ? modelDisplayName(model) : "Default"} />
            <Stat label="Mode" value={mode.label} />
            <Stat label="Messages here" value={count === null ? "…" : String(count)} />
            <Stat label="Spend this month" value={usage(formatCents(totals.cents))} />
            <Stat label="Tokens in" value={usage(formatTokens(totals.input))} />
            <Stat label="Tokens out" value={usage(formatTokens(totals.output))} />
          </dl>
          {byModel.isError ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              Couldn’t load this month’s usage: {byModel.error.message}
            </p>
          ) : null}
          {rows.length > 1 ? (
            <section className="mt-4" aria-label="By model">
              <p className="mb-1 text-xs font-medium text-muted-foreground">By model</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {rows.map((row) => (
                  <li key={`${row.model}:${row.provider}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <ModelLogo modelId={row.model} provider={row.provider === "other" ? undefined : (row.provider as ModelProvider)} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{modelDisplayName(row.model)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatTokens(row.inputTokens + (row.cachedInputTokens ?? 0))} in · {formatTokens(row.outputTokens)} out · {formatCents(row.costCents)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="mt-4 text-xs text-muted-foreground">
            A fresh session (<span className="font-mono text-foreground">/new</span>) clears what the agent carries between turns; the
            messages above stay in this chat.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}
