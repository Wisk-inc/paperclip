import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Cpu, KeyRound } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { ModelLogo } from "@/components/ModelLogo";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { modelDisplayName } from "@/lib/model-brand";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { ModelPickerSheet } from "./ModelPickerSheet";
import { ThinkingDepthControl, thinkingLevelsFor } from "./ThinkingDepthControl";

/** How a Claude agent runs: the Claude Code program, or the Anthropic API with its own tools. */
const CLAUDE_ENGINES = [
  {
    value: "api",
    label: "Anthropic API",
    hint: "Uses your API key. Reads, edits and runs code with its own tools, on a phone too.",
  },
  {
    value: "auto",
    label: "Claude Code",
    hint: "The Claude Code program on the computer that runs Automa. Phones use the API instead.",
  },
] as const;

/**
 * An agent's AI settings in one place: its model, how long it thinks, and
 * (for Claude) how it runs. Every change saves at once.
 */
export function AgentAiSettings({ agent, onNavigate }: { agent: Agent; onNavigate: () => void }) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const [modelOpen, setModelOpen] = useState(false);
  const modelButtonRef = useRef<HTMLButtonElement | null>(null);
  const model = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const engine = agent.adapterConfig?.engine === "api" ? "api" : "auto";
  const hasThinking = thinkingLevelsFor(agent).length > 0;

  const setEngine = useMutation({
    mutationFn: (next: string) => agentsApi.update(agent.id, { adapterConfig: { engine: next } }, agent.companyId),
    onSuccess: async (_updated, next) => {
      haptic("success");
      pushToast({ title: next === "api" ? `${agent.name} uses the Anthropic API` : `${agent.name} uses Claude Code`, tone: "success" });
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) }),
        client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
      ]);
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn’t change it", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  return (
    <div className="space-y-5" data-testid="agent-ai-settings">
      <div className="grid gap-1.5">
        <span className="text-sm font-medium text-foreground">Model</span>
        <button
          ref={modelButtonRef}
          type="button"
          onClick={() => {
            haptic("tick");
            setModelOpen(true);
          }}
          className="flex min-h-12 w-full items-center gap-3 rounded-lg border border-border bg-card px-3 text-left transition-colors hover:bg-accent/60"
          data-testid="agent-ai-model"
        >
          <ModelLogo modelId={model} adapterType={agent.adapterType} size="sm" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{modelDisplayName(model)}</span>
          <span className="text-xs text-muted-foreground">Change</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </div>

      {hasThinking ? (
        <ThinkingDepthControl agent={agent} />
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
          {modelDisplayName(model)} has no thinking modes to choose from. Pick another model to get them.
        </p>
      )}

      {agent.adapterType === "claude_local" ? (
        <fieldset className="grid gap-2">
          <legend className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
            <Cpu className="size-4 text-muted-foreground" aria-hidden="true" />
            How {agent.name} runs
          </legend>
          {CLAUDE_ENGINES.map((option) => {
            const active = engine === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                disabled={setEngine.isPending}
                onClick={() => {
                  if (active) return;
                  haptic("tick");
                  setEngine.mutate(option.value);
                }}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors",
                  active ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/60",
                )}
              >
                <span className="text-sm font-medium text-foreground">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.hint}</span>
              </button>
            );
          })}
        </fieldset>
      ) : null}

      <Link
        to="/company/settings/api-keys"
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm text-foreground hover:bg-accent/60"
      >
        <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1">API keys, balance and spending limit</span>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
      </Link>

      <ModelPickerSheet agent={agent} open={modelOpen} onOpenChange={setModelOpen} returnFocusRef={modelButtonRef} />
    </div>
  );
}
