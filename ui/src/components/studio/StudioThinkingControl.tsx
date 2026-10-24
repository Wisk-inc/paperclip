import { Brain } from "lucide-react";
import { studioThinkingLevels, type StudioAiProvider, type StudioThinkingLevel } from "@paperclipai/shared";
import { THINKING_LEVELS } from "@/components/agent-chat/ThinkingDepthControl";
import { haptic } from "@/lib/haptics";
import { modelDisplayName } from "@/lib/model-brand";
import { handleRadioGroupKeyDown, radioTabIndex } from "@/lib/radio-group-keys";
import { cn } from "@/lib/utils";

/** The picked level when the model takes it; otherwise the model decides. */
export function effectiveStudioThinking(provider: StudioAiProvider, model: string, level: StudioThinkingLevel | undefined) {
  return level && studioThinkingLevels(provider, model).includes(level) ? level : undefined;
}

/**
 * How long Studio's assistant thinks before it acts, as one row of choices.
 * Its thoughts show live in the panel whichever level is picked.
 */
export function StudioThinkingControl({
  provider,
  model,
  value,
  onChange,
}: {
  provider: StudioAiProvider;
  model: string;
  value: StudioThinkingLevel | undefined;
  onChange: (level: StudioThinkingLevel | undefined) => void;
}) {
  const levels: Array<StudioThinkingLevel | ""> = studioThinkingLevels(provider, model);
  if (levels.length === 0) {
    return model.trim() ? (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="studio-thinking-none">
        <Brain className="size-3.5" aria-hidden="true" />
        {modelDisplayName(model)} has no thinking modes to pick from.
      </p>
    ) : null;
  }
  const options: Array<StudioThinkingLevel | ""> = ["", ...levels];
  const active = effectiveStudioThinking(provider, model, value) ?? "";
  const choose = (level: StudioThinkingLevel | "") => {
    if (level === active) return;
    haptic("tick");
    onChange(level || undefined);
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="studio-thinking">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Brain className="size-3.5" aria-hidden="true" />
        Thinking
        <span className="min-w-0 truncate font-normal">· {THINKING_LEVELS[active]?.hint ?? ""}</span>
      </div>
      <div
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5"
        role="radiogroup"
        aria-label="Thinking depth"
        onKeyDown={(event) => handleRadioGroupKeyDown(event, (index) => choose(options[index]))}
      >
        {options.map((level, index) => {
          const selected = level === active;
          return (
            <button
              key={level || "auto"}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={radioTabIndex(selected, index, true)}
              onClick={() => choose(level)}
              className={cn(
                "min-h-9 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors duration-(--motion-duration-fast)",
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
