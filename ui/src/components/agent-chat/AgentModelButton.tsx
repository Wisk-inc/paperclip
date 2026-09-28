import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { ModelLogo } from "@/components/ModelLogo";
import { haptic } from "@/lib/haptics";
import { modelDisplayName } from "@/lib/model-brand";
import { cn } from "@/lib/utils";
import { ModelPickerSheet } from "./ModelPickerSheet";

/** The agent's current model as a chip in the chat header; tapping it opens the model switcher. */
export function AgentModelButton({ agent, className }: { agent: Agent; className?: string }) {
  const [open, setOpen] = useState(false);
  const model = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const name = modelDisplayName(model);
  return (
    <>
      <button
        type="button"
        data-slot="agent-model-button"
        aria-haspopup="dialog"
        aria-label={`Model: ${name}. Change model`}
        onClick={() => {
          haptic("tick");
          setOpen(true);
        }}
        className={cn(
          "inline-flex h-8 max-w-40 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card pr-2 pl-1.5 text-xs font-medium text-foreground transition-colors md:max-w-56",
          "hover:bg-accent active:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
          className,
        )}
      >
        <ModelLogo modelId={model} adapterType={agent.adapterType} size="sm" tile={false} />
        <span className="min-w-0 truncate">{name}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      <ModelPickerSheet agent={agent} open={open} onOpenChange={setOpen} />
    </>
  );
}
