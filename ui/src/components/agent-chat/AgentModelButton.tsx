import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { BondedModelLogos } from "@/components/BondedModelLogos";
import { ModelLogo } from "@/components/ModelLogo";
import { haptic } from "@/lib/haptics";
import { modelDisplayName } from "@/lib/model-brand";
import { cn } from "@/lib/utils";
import { ModelPickerSheet } from "./ModelPickerSheet";

/** The agent's current model as a chip in the chat header; tapping it opens the model switcher. */
export function AgentModelButton({ agent, className }: { agent: Agent; className?: string }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const model = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const name = modelDisplayName(model);
  const imageModel = agent.adapterType === "free_models" && typeof agent.adapterConfig?.imageModel === "string" ? agent.adapterConfig.imageModel : "";
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-slot="agent-model-button"
        aria-haspopup="dialog"
        aria-label={`Model: ${name}${imageModel ? ` with ${modelDisplayName(imageModel)}` : ""}. Change model`}
        onClick={() => {
          haptic("tick");
          setOpen(true);
        }}
        className={cn(
          "inline-flex h-10 max-w-28 shrink-0 items-center justify-center sm:max-w-40 gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-foreground transition-colors md:max-w-56 @md/header:pr-2 @md/header:pl-1.5",
          "hover:bg-accent active:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
          className,
        )}
      >
        {imageModel ? (
          <BondedModelLogos chatModelId={model} imageModelId={imageModel} size="sm" tile={false} />
        ) : (
          <ModelLogo modelId={model} adapterType={agent.adapterType} size="sm" tile={false} />
        )}
        {/* On phones narrower than 28rem the chat title needs the room, so
            the header shows just the model's logo (the label still names it). */}
        <span className="hidden min-w-0 truncate @md/header:inline">{name}</span>
        <ChevronDown className="hidden size-3.5 shrink-0 text-muted-foreground @md/header:inline" aria-hidden="true" />
      </button>
      <ModelPickerSheet agent={agent} open={open} onOpenChange={setOpen} returnFocusRef={buttonRef} />
    </>
  );
}
