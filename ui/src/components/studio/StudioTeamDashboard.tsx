import { useState } from "react";
import { Activity, ChevronRight, MessageSquare, Sparkles, Zap } from "lucide-react";
import type { StudioAssistantTurn } from "@paperclipai/shared";
import { ModelLogo } from "@/components/ModelLogo";
import { MarkdownBody } from "@/components/MarkdownBody";
import { modelDisplayName } from "@/lib/model-brand";
import { cn } from "@/lib/utils";
import { formatSpend, formatTokens, modelTotals } from "./studio-usage";

/**
 * The Stats tab: every model that worked in this chat (the lead and each
 * teammate) with its logo, tokens and cost, and everything the team said to
 * each other, newest reply first.
 */
export function StudioTeamDashboard({ turns }: { turns: StudioAssistantTurn[] }) {
  const [chatOpen, setChatOpen] = useState(true);
  const models = modelTotals(turns);
  const conversations = turns.filter((turn) => turn.role === "assistant" && turn.teamChat?.length).reverse();

  if (!models.length) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center" data-testid="studio-team-dashboard-empty">
        <Sparkles className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          Ask the AI something. Every model that works on it shows here with the tokens it used, and when you pick a team in the model menu, so does what the teammates say to each other.
        </p>
      </div>
    );
  }

  const tokens = models.reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0);
  const allFree = models.every((model) => model.provider === "free");
  const paid = models.filter((model) => model.provider !== "free");
  const cost = paid.every((model) => model.costUsd !== null) ? paid.reduce((sum, model) => sum + (model.costUsd ?? 0), 0) : null;
  const stats = [
    { label: "Models", value: String(models.length), icon: Zap },
    { label: "Tokens", value: formatTokens(tokens), icon: Activity },
    { label: "Cost", value: allFree ? "Free" : cost === null ? "—" : (formatSpend(null, cost) ?? "—"), icon: Sparkles },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3" data-testid="studio-team-dashboard">
      <dl className="grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-lg border border-border bg-background p-2.5">
            <dt className="flex items-center gap-1 text-xs text-muted-foreground">
              <stat.icon className="size-3" aria-hidden="true" /> {stat.label}
            </dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>

      <section className="flex flex-col gap-1.5" aria-labelledby="studio-stats-models">
        <h3 id="studio-stats-models" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Tokens per model
        </h3>
        <ul className="flex flex-col gap-1.5">
          {models.map((model) => {
            const used = model.inputTokens + model.outputTokens;
            const spend = formatSpend(model.provider, model.costUsd);
            const share = tokens ? Math.max(2, Math.round((used / tokens) * 100)) : 0;
            return (
              <li key={`${model.provider}:${model.model}`} className="flex items-center gap-2.5 rounded-lg border border-border bg-card p-2.5" data-testid="studio-dashboard-model">
                <ModelLogo modelId={model.model} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{modelDisplayName(model.model)}</span>
                    {spend ? <span className="shrink-0 text-xs text-muted-foreground">{spend}</span> : null}
                  </div>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {formatTokens(model.inputTokens)} in · {formatTokens(model.outputTokens)} out · {model.jobs} {model.jobs === 1 ? "job" : "jobs"}
                  </p>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {conversations.length ? (
        <section className="flex flex-col gap-1.5" aria-label="Team chat">
          <button
            type="button"
            aria-expanded={chatOpen}
            onClick={() => setChatOpen((value) => !value)}
            className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            <MessageSquare className="size-3.5" aria-hidden="true" />
            What the team said
            <ChevronRight className={cn("size-3 transition-transform duration-(--motion-duration-fast)", chatOpen && "rotate-90")} aria-hidden="true" />
          </button>
          {chatOpen
            ? conversations.map((turn) => (
                <ol key={turn.id} className="flex flex-col gap-2 border-l-2 border-border pl-2.5" data-testid="studio-dashboard-chat">
                  {turn.teamChat!.map((message) => (
                    <li key={message.id} className="flex min-w-0 gap-2">
                      <ModelLogo modelId={message.fromModel} size="xs" className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs">
                          <span className="font-medium">{message.fromName}</span>
                          <span className="text-muted-foreground"> {message.kind === "task" ? "to" : message.kind === "report" ? "reported to" : "→"} </span>
                          <span className="font-medium">{message.toName ?? "everyone"}</span>
                        </p>
                        <div className="max-h-36 min-w-0 overflow-hidden text-sm break-words text-muted-foreground">
                          <MarkdownBody softBreaks>{message.text}</MarkdownBody>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              ))
            : null}
        </section>
      ) : null}
    </div>
  );
}
