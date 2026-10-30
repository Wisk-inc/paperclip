import { useEffect, useState } from "react";
import { Activity, ChevronRight, Clock, Coins, FileCode2, Footprints, MessageSquare, Sparkles, Tag, Zap } from "lucide-react";
import type { StudioAssistantTurn } from "@paperclipai/shared";
import { ModelLogo } from "@/components/ModelLogo";
import { MarkdownBody } from "@/components/MarkdownBody";
import { plainSnippet } from "@/lib/background-notify";
import { modelDisplayName } from "@/lib/model-brand";
import { cn } from "@/lib/utils";
import {
  changedFiles,
  formatAgo,
  formatCostAndWorth,
  formatElapsed,
  formatTokens,
  formatUsd,
  isWorkStep,
  latestMoves,
  modelTotals,
  turnWorkers,
  type TurnWorker,
} from "./studio-usage";

const STEP_VERB: Record<string, string> = {
  say: "Said",
  ask_teammate: "Asked a teammate",
  run_team: "Put the team to work",
  message_team: "Messaged the team",
  web_search: "Searched the web",
  web_fetch: "Read a web page",
  list_files: "Looked at the files",
  search_files: "Searched the files",
  read_console: "Read the console",
  run_command: "Ran",
};

/** A step's summary already says what was done ("Edited app.js", "Looked at / on a phone…"). */
const SAYS_ITS_VERB = /^(?:Looked|Started|Stopped|Read|Edited|Created|Rewrote|Deleted|Searched|Listed|Ran|Asked|Told|Undid|Put|Messaged|Wrote)\b/;

function moveText(tool: string, summary: string): string {
  if (tool === "say") return `Said: ${plainSnippet(summary, 160)}`;
  const verb = STEP_VERB[tool];
  return verb && !SAYS_ITS_VERB.test(summary) ? `${verb} · ${summary}` : summary;
}

/** The time now, every second while the team works (the timer and "12s ago"), every half minute otherwise. */
function useNow(fast: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => window.clearInterval(timer);
  }, [fast]);
  return now;
}

function WorkerStatus({ status }: { status: TurnWorker["status"] }) {
  if (status === "working") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-(length:--text-micro) font-medium text-primary">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
        Working
      </span>
    );
  }
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-(length:--text-micro) font-medium",
        status === "failed" ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground",
      )}
    >
      {status === "failed" ? "Failed" : "Done"}
    </span>
  );
}

/** The reply being written right now: a running clock, what each model is doing, and its tokens as they count. */
function LivePanel({ turn, startedAt, now }: { turn: StudioAssistantTurn | null; startedAt: number; now: number }) {
  const workers = turn ? turnWorkers(turn, { leadWorking: true }) : [];
  const steps = turn?.steps.filter(isWorkStep).length ?? 0;
  const files = turn ? changedFiles([turn]).length : 0;
  const tokens = workers.reduce((sum, worker) => sum + (worker.usage ? worker.usage.inputTokens + worker.usage.outputTokens : 0), 0);
  const teamWorking = turn?.agents?.filter((agent) => agent.status === "working").length ?? 0;
  const doing = !turn
    ? "Getting started…"
    : teamWorking > 1
      ? `${teamWorking} teammates working…`
      : turn.activity
        ? `${turn.activity}…`
        : turn.liveThinking
          ? "Thinking it through…"
          : turn.live
            ? "Writing the reply…"
            : steps > 0
              ? "Deciding what to do next…"
              : `Waiting for ${modelDisplayName(turn.model)}…`;
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3" aria-label="Working now" data-testid="studio-stats-live">
      <div className="flex items-center gap-2">
        <span className="relative flex size-2.5" aria-hidden="true">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
        </span>
        <span className="text-sm font-medium">Working now</span>
        <span className="ml-auto flex items-center gap-1 text-xs tabular-nums text-muted-foreground" data-testid="studio-stats-elapsed">
          <Clock className="size-3" aria-hidden="true" />
          {formatElapsed(Math.max(0, Math.round((now - startedAt) / 1000)))}
        </span>
      </div>
      <p className="truncate text-xs text-foreground" aria-live="polite" data-testid="studio-stats-doing">
        {doing}
      </p>
      <p className="text-xs tabular-nums text-muted-foreground" data-testid="studio-stats-live-counts">
        {steps === 1 ? "1 step" : `${steps} steps`} · {files === 1 ? "1 file changed" : `${files} files changed`} · {formatTokens(tokens)} tokens
      </p>
      {workers.length ? (
        <ul className="flex flex-col gap-1.5" aria-label="Models at work">
          {workers.map((worker) => {
            const agent = worker.lead ? null : turn?.agents?.find((candidate) => candidate.id === worker.id);
            const lastStep = turn?.steps.findLast((step) => (worker.lead ? !step.agent : step.agent === worker.id) && isWorkStep(step));
            const doingNow = worker.status === "working" ? (worker.lead ? turn?.activity : agent?.activity) : null;
            const worth = worker.usage ? formatCostAndWorth({ free: worker.provider === "free", costUsd: worker.usage.costUsd, equivalentUsd: worker.usage.equivalentUsd }) : null;
            return (
              <li key={worker.id} className="studio-boot-in flex items-center gap-2 rounded-md bg-background p-2" data-testid="studio-stats-worker">
                <ModelLogo modelId={worker.model} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm font-medium">{worker.name}</span>
                    {worker.role ? <span className="min-w-0 truncate text-xs text-muted-foreground">{worker.role}</span> : null}
                    <WorkerStatus status={worker.status} />
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {doingNow ? `${doingNow}…` : lastStep ? lastStep.summary : agent?.task ?? "Reading the request"}
                  </p>
                </div>
                <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {worker.usage ? formatTokens(worker.usage.inputTokens + worker.usage.outputTokens) : "0"}
                  {worth ? <span className="block">{worth}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The Stats tab: live while the AI works (a running clock, what each model is
 * doing, tokens and steps as they happen), then every model that worked in
 * this chat with its logo, tokens, cost and what the same work costs at paid
 * prices, the latest moves, and everything the team said to each other.
 */
export function StudioTeamDashboard({ turns, running = false }: { turns: StudioAssistantTurn[]; running?: boolean }) {
  const [chatOpen, setChatOpen] = useState(true);
  const now = useNow(running);
  const models = modelTotals(turns);
  const conversations = turns.filter((turn) => turn.role === "assistant" && turn.teamChat?.length).reverse();
  const last = turns.at(-1);
  const liveTurn = running && last?.role === "assistant" ? last : null;
  const liveStart = Date.parse(liveTurn?.createdAt ?? turns.findLast((turn) => turn.role === "user")?.createdAt ?? "") || now;

  if (!models.length && !running) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-center" data-testid="studio-team-dashboard-empty">
        <Sparkles className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          Ask the AI something. This tab follows it live: every model that works on it with the tokens it uses, what that would cost at paid prices, each step and file it changes, and when you pick a team in the model menu, what the teammates say to each other.
        </p>
      </div>
    );
  }

  const tokens = models.reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0);
  const allFree = models.every((model) => model.provider === "free");
  const paid = models.filter((model) => model.provider !== "free");
  const cost = paid.every((model) => model.costUsd !== null) ? paid.reduce((sum, model) => sum + (model.costUsd ?? 0), 0) : null;
  const worth = models.reduce((sum, model) => sum + model.equivalentUsd, 0);
  const steps = turns.reduce((sum, turn) => sum + (turn.role === "assistant" ? turn.steps.filter(isWorkStep).length : 0), 0);
  const files = changedFiles(turns).length;
  const moves = latestMoves(turns, 12);
  const stats = [
    { label: "Models", value: String(models.length), icon: Zap, hint: undefined },
    { label: "Tokens", value: formatTokens(tokens), icon: Activity, hint: undefined },
    { label: "Cost", value: allFree ? "Free" : cost === null ? "—" : (formatUsd(cost) ?? "—"), icon: Coins, hint: "What you were charged" },
    { label: "Would cost", value: formatUsd(worth) ?? "—", icon: Tag, hint: "The same tokens at the paid models' list prices" },
    { label: "Steps", value: String(steps), icon: Footprints, hint: "Tools the models ran" },
    { label: "Files", value: String(files), icon: FileCode2, hint: "Files created, changed or deleted" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3" data-testid="studio-team-dashboard">
      {running ? <LivePanel turn={liveTurn} startedAt={liveStart} now={now} /> : null}

      <dl className="grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-lg border border-border bg-background p-2.5" title={stat.hint}>
            <dt className="flex items-center gap-1 text-xs text-muted-foreground">
              <stat.icon className="size-3" aria-hidden="true" /> {stat.label}
            </dt>
            <dd className="mt-0.5 truncate text-xl font-semibold tabular-nums" data-testid={`studio-stat-${stat.label.toLowerCase().replace(/\s+/g, "-")}`}>
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>

      {models.length ? (
        <section className="flex flex-col gap-1.5" aria-labelledby="studio-stats-models">
          <h3 id="studio-stats-models" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Tokens per model
          </h3>
          <ul className="flex flex-col gap-1.5">
            {models.map((model) => {
              const used = model.inputTokens + model.outputTokens;
              const spend = formatCostAndWorth({ free: model.provider === "free", costUsd: model.costUsd, equivalentUsd: model.equivalentUsd });
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
                      <div className="h-full rounded-full bg-primary transition-all duration-(--motion-duration-slow)" style={{ width: `${share}%` }} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {moves.length ? (
        <section className="flex flex-col gap-1.5" aria-labelledby="studio-stats-moves">
          <h3 id="studio-stats-moves" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Latest moves
          </h3>
          <ol className="flex flex-col gap-1" data-testid="studio-stats-moves">
            {moves.map((move) => {
              const ago = formatAgo(move.step.at, now);
              return (
                <li key={move.key} className="studio-boot-in flex min-w-0 items-start gap-2 text-xs">
                  <ModelLogo modelId={move.model} size="xs" className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{move.lead ? `${move.who} (lead)` : move.who}</span>{" "}
                    <span className={cn("break-words text-muted-foreground", !move.step.ok && "text-destructive")}>{moveText(move.step.tool, move.step.summary)}</span>
                  </span>
                  {ago ? <span className="shrink-0 tabular-nums text-muted-foreground">{ago}</span> : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

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
                          {formatAgo(message.createdAt, now) ? <span className="text-muted-foreground"> · {formatAgo(message.createdAt, now)}</span> : null}
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
