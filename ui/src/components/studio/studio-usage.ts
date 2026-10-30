import type { StudioAssistantTurn, StudioTokenUsage } from "@paperclipai/shared";
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
  /** Replies (as lead) and assignments (as teammate) it took part in. */
  jobs: number;
}

function add(total: ModelTotals, usage: StudioTokenUsage | null) {
  total.jobs += 1;
  if (!usage) return;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.costUsd = total.costUsd === null || usage.costUsd === null ? null : total.costUsd + usage.costUsd;
}

/** Every model in this chat, with its tokens and cost added up across replies; most tokens first. */
export function modelTotals(turns: StudioAssistantTurn[]): ModelTotals[] {
  const byModel = new Map<string, ModelTotals>();
  for (const turn of turns) {
    if (turn.role !== "assistant" || !turn.model) continue;
    for (const worker of turnWorkers(turn)) {
      const key = `${worker.provider}:${worker.model}`;
      const total = byModel.get(key) ?? { provider: worker.provider, model: worker.model, inputTokens: 0, outputTokens: 0, costUsd: 0, jobs: 0 };
      add(total, worker.usage);
      byModel.set(key, total);
    }
  }
  return [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}
