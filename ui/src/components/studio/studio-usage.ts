import type { StudioAssistantStep, StudioAssistantTurn, StudioTokenUsage } from "@paperclipai/shared";
import { modelDisplayName } from "@/lib/model-brand";

/** 950, 1.2k, 34k, 1.5M. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

/** "Free" on the free models; otherwise the cost, or null when it is not known. */
export function formatSpend(provider: string | null | undefined, costUsd: number | null): string | null {
  if (provider === "free") return "Free";
  if (costUsd === null) return null;
  if (costUsd === 0) return "$0.00";
  return costUsd < 0.01 ? "under 1¢" : `$${costUsd.toFixed(2)}`;
}

/** "$0.42", "under 1¢", "$0.00"; null when unknown. */
export function formatUsd(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
  if (usd <= 0) return "$0.00";
  return usd < 0.01 ? "under 1¢" : `$${usd.toFixed(2)}`;
}

/**
 * What the work cost, and what it would have cost at paid list prices:
 * "Free · worth $0.42" on the free models, "$0.12 · worth $0.40" for a team
 * that mixed free and paid models, and just the cost for paid models (their
 * worth is their cost).
 */
export function formatCostAndWorth(input: { free: boolean; costUsd: number | null; equivalentUsd?: number | null }): string | null {
  const equivalent = input.equivalentUsd ?? null;
  const worth = equivalent !== null && equivalent > 0 ? formatUsd(equivalent) : null;
  const paid = input.free ? "Free" : formatUsd(input.costUsd);
  if (!paid) return worth ? `worth ${worth}` : null;
  if (!worth) return paid;
  if (!input.free && input.costUsd !== null && Math.abs(equivalent! - input.costUsd) < 0.005) return paid;
  return `${paid} · worth ${worth}`;
}

/** One model at work in a reply: the lead or a teammate, with what its own calls used. */
export interface TurnWorker {
  id: string;
  name: string;
  provider: string;
  model: string;
  role: string | null;
  lead: boolean;
  status: "working" | "done" | "failed";
  usage: StudioTokenUsage | null;
}

/** The lead first, then each teammate. Replies saved before per-model counts give the lead the whole reply's usage. */
export function turnWorkers(turn: StudioAssistantTurn, options: { leadWorking?: boolean } = {}): TurnWorker[] {
  const agents = turn.agents ?? [];
  const legacyLeadUsage = !turn.leadUsage && !agents.some((agent) => agent.usage) ? (turn.usage ?? null) : null;
  return [
    {
      id: "lead",
      name: modelDisplayName(turn.model),
      provider: turn.provider ?? "free",
      model: turn.model ?? "",
      role: agents.length ? "lead" : null,
      lead: true,
      status: options.leadWorking ? "working" : turn.error ? "failed" : "done",
      usage: turn.leadUsage ?? legacyLeadUsage,
    },
    ...agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      role: agent.role,
      lead: false,
      status: agent.status,
      usage: agent.usage ?? null,
    })),
  ];
}

export interface ModelTotals {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Null once any call's cost was unknown. */
  costUsd: number | null;
  /** At paid list prices: the free models' would-have-cost, the paid models' cost. */
  equivalentUsd: number;
  /** Replies (as lead) and assignments (as teammate) it took part in. */
  jobs: number;
}

/** What a usage would cost at paid list prices; replies saved before the worth was counted give their cost. */
export function usageWorth(usage: StudioTokenUsage | null | undefined): number {
  if (!usage) return 0;
  return usage.equivalentUsd ?? usage.costUsd ?? 0;
}

function add(total: ModelTotals, usage: StudioTokenUsage | null) {
  total.jobs += 1;
  if (!usage) return;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.costUsd = total.costUsd === null || usage.costUsd === null ? null : total.costUsd + usage.costUsd;
  total.equivalentUsd += usageWorth(usage);
}

/** Every model in this chat, with its tokens and cost added up across replies; most tokens first. */
export function modelTotals(turns: StudioAssistantTurn[]): ModelTotals[] {
  const byModel = new Map<string, ModelTotals>();
  for (const turn of turns) {
    if (turn.role !== "assistant" || !turn.model) continue;
    for (const worker of turnWorkers(turn)) {
      const key = `${worker.provider}:${worker.model}`;
      const total = byModel.get(key) ?? { provider: worker.provider, model: worker.model, inputTokens: 0, outputTokens: 0, costUsd: 0, equivalentUsd: 0, jobs: 0 };
      add(total, worker.usage);
      byModel.set(key, total);
    }
  }
  return [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}

/** 42s, 3:07. */
export function formatElapsed(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "just now", "12s ago", "4m ago", "2h ago"; null without a time. */
export function formatAgo(at: string | undefined, now: number): string | null {
  const then = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

const FILE_TOOLS = new Set(["write_file", "edit_file", "delete_path"]);

/** A tool the model ran (not something it said or thought). */
export function isWorkStep(step: StudioAssistantStep): boolean {
  return step.tool !== "say" && step.tool !== "think";
}

/** The files the AI created, changed or deleted in these replies (undone changes left out). */
export function changedFiles(turns: StudioAssistantTurn[]): string[] {
  const paths = new Set<string>();
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (FILE_TOOLS.has(step.tool) && step.ok && !step.undone && step.path) paths.add(step.path);
    }
  }
  return [...paths];
}

/** One move in the latest-moves feed: who did it, with which model, and when. */
export interface TeamMove {
  key: string;
  step: StudioAssistantStep;
  who: string;
  model: string;
  lead: boolean;
}

/** The newest moves across these replies (tools run, things said), newest first. */
export function latestMoves(turns: StudioAssistantTurn[], limit = 12): TeamMove[] {
  const moves: TeamMove[] = [];
  for (let t = turns.length - 1; t >= 0 && moves.length < limit; t -= 1) {
    const turn = turns[t]!;
    if (turn.role !== "assistant") continue;
    for (let s = turn.steps.length - 1; s >= 0 && moves.length < limit; s -= 1) {
      const step = turn.steps[s]!;
      if (step.tool === "think") continue;
      const agent = step.agent ? turn.agents?.find((candidate) => candidate.id === step.agent) : undefined;
      moves.push({
        key: `${turn.id}:${s}`,
        step,
        who: agent?.name ?? modelDisplayName(turn.model),
        model: agent?.model ?? turn.model ?? "",
        lead: !agent,
      });
    }
  }
  return moves;
}
