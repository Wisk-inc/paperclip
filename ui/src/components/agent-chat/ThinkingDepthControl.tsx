import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { useOptionalToastActions } from "@/context/ToastContext";
import { setupEfforts } from "@/lib/agent-setup-fields";
import { haptic } from "@/lib/haptics";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/** What each effort level is called in the app, and what it means for a reply. */
export const THINKING_LEVELS: Record<string, { label: string; hint: string }> = {
  "": { label: "Auto", hint: "The model decides how long to think." },
  off: { label: "Off", hint: "Answers right away." },
  minimal: { label: "Minimal", hint: "A moment of thought." },
  low: { label: "Quick", hint: "Fast answers, light thinking." },
  medium: { label: "Balanced", hint: "Thinks when it helps." },
  high: { label: "Deep", hint: "Thinks things through." },
  xhigh: { label: "Deeper", hint: "Longer thinking for hard problems." },
  max: { label: "Max", hint: "As much thinking as it needs. Slowest and priciest." },
  ultra: { label: "Ultra", hint: "Codex's deepest level. Slowest and priciest." },
};

/**
 * The setting each runtime reads its thinking level from. Writing "effort"
 * everywhere looked saved but never reached Codex, Grok or Pi.
 */
export function thinkingConfigKey(adapterType: string): string {
  switch (adapterType) {
    case "codex_local":
      return "modelReasoningEffort";
    case "grok_local":
      return "reasoningEffort";
    case "pi_local":
      return "thinking";
    default:
      return "effort";
  }
}

/** The change that sets a level, clearing the generic key where another one is read. */
export function thinkingLevelPatch(agent: Pick<Agent, "adapterType">, level: string): Record<string, string> {
  const key = thinkingConfigKey(agent.adapterType);
  return key === "effort" ? { effort: level } : { [key]: level, effort: "" };
}

export function thinkingLevelsFor(agent: Pick<Agent, "adapterType" | "adapterConfig">): string[] {
  const model = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const efforts = setupEfforts(agent.adapterType, model);
  return efforts.length ? ["", ...efforts] : [];
}

export function currentThinkingLevel(agent: Pick<Agent, "adapterType" | "adapterConfig">): string {
  const own = agent.adapterConfig?.[thinkingConfigKey(agent.adapterType)];
  if (typeof own === "string" && own) return own;
  const effort = agent.adapterConfig?.effort;
  return typeof effort === "string" ? effort : "";
}

/** Matches a typed level ("deep", "max", "quick") to one the agent's model takes. */
export function resolveThinkingLevel(agent: Pick<Agent, "adapterType" | "adapterConfig">, query: string): string | null {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return null;
  const levels = thinkingLevelsFor(agent);
  for (const level of levels) {
    if (level === wanted || THINKING_LEVELS[level]?.label.toLowerCase() === wanted) return level;
  }
  if (wanted === "auto" || wanted === "default") return levels.includes("") ? "" : null;
  return null;
}

export function useSetThinkingLevel(agent: Agent, onSaved?: (level: string) => void) {
  const client = useQueryClient();
  const toast = useOptionalToastActions();
  return useMutation({
    mutationFn: (effort: string) => agentsApi.update(agent.id, { adapterConfig: thinkingLevelPatch(agent, effort) }, agent.companyId),
    onSuccess: async (_updated, effort) => {
      onSaved?.(effort);
      haptic("success");
      const level = THINKING_LEVELS[effort] ?? { label: effort, hint: "" };
      toast?.pushToast({ title: `Thinking: ${level.label}`, body: level.hint, tone: "success" });
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) }),
        client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
      ]);
    },
    onError: (error) => {
      haptic("warning");
      toast?.pushToast({ title: "Couldn’t change thinking", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });
}

/**
 * How long the agent thinks before it answers, as one row of choices. Its
 * thoughts show live in the chat while it thinks, whichever level is picked.
 */
export function ThinkingDepthControl({ agent, className }: { agent: Agent; className?: string }) {
  const levels = thinkingLevelsFor(agent);
  const saved = currentThinkingLevel(agent);
  // The agent passed in can be a snapshot from when the page opened; the last
  // level saved here is shown (and compared against) until it catches up.
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(null), [saved]);
  const current = chosen ?? saved;
  const setLevel = useSetThinkingLevel(agent, setChosen);
  if (levels.length === 0) return null;
  const pending = setLevel.isPending ? setLevel.variables : null;
  const active = pending ?? current;
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-testid="thinking-depth">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Brain className="size-3.5" aria-hidden="true" />
        Thinking
        <span className="min-w-0 truncate font-normal">· {THINKING_LEVELS[active]?.hint ?? ""}</span>
      </div>
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5" role="radiogroup" aria-label="Thinking depth">
        {levels.map((level) => {
          const selected = level === active;
          return (
            <button
              key={level || "auto"}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={setLevel.isPending}
              onClick={() => {
                if (level === current) return;
                haptic("tick");
                setLevel.mutate(level);
              }}
              className={cn(
                "min-h-9 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors duration-(--motion-duration-fast) disabled:opacity-60",
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              data-thinking-level={level || "auto"}
            >
              {THINKING_LEVELS[level]?.label ?? level}
            </button>
          );
        })}
      </div>
    </div>
  );
}
