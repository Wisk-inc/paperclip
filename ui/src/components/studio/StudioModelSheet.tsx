import { useState } from "react";
import { Check, ChevronDown, KeyRound } from "lucide-react";
import {
  STUDIO_AI_PROVIDERS,
  STUDIO_AI_PROVIDER_INFO,
  type StudioAiKeyStatus,
  type StudioAiProvider,
} from "@paperclipai/shared";
import { ModelLogo } from "@/components/ModelLogo";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { haptic } from "@/lib/haptics";
import { modelDisplayName, type ModelProvider } from "@/lib/model-brand";
import { cn } from "@/lib/utils";

/** Studio's provider ids, as the logo set names them. */
function logoProvider(provider: StudioAiProvider): ModelProvider {
  switch (provider) {
    case "anthropic":
    case "openai":
    case "openrouter":
    case "google":
    case "deepseek":
    case "xai":
    case "mistral":
      return provider;
    default:
      return "other";
  }
}

function shortName(provider: StudioAiProvider) {
  return STUDIO_AI_PROVIDER_INFO[provider].name.replace(/ \(.*\)$/, "");
}

function keyLabel(status: StudioAiKeyStatus | undefined) {
  if (!status?.connected) return null;
  return status.source === "automa" ? "Organization key" : "Key saved";
}

/**
 * The button at the top of Studio's AI panel: the model's logo and name. It
 * opens one sheet to pick the provider (each with its key status) and the
 * model, instead of two system drop-downs.
 */
export function StudioModelSheet({
  provider,
  model,
  keys,
  onChange,
}: {
  provider: StudioAiProvider;
  model: string;
  keys: StudioAiKeyStatus[];
  onChange: (next: { provider: StudioAiProvider; model: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const info = STUDIO_AI_PROVIDER_INFO[provider];
  const models = info.models.includes(model) || !model ? info.models : [model, ...info.models];
  const status = keys.find((key) => key.provider === provider);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          haptic("tick");
          setOpen(true);
        }}
        className="flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-left transition-colors duration-(--motion-duration-fast) hover:bg-accent/40"
        aria-label={`AI model: ${modelDisplayName(model)} from ${shortName(provider)}. Change`}
        data-testid="studio-model-button"
      >
        <ModelLogo modelId={model} provider={provider === "anthropic" || provider === "openai" ? undefined : logoProvider(provider)} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{model ? modelDisplayName(model) : "Pick a model"}</span>
          <span className="truncate text-xs text-muted-foreground">
            {shortName(provider)}
            {keyLabel(status) ? ` · ${keyLabel(status)}` : " · Add a key to start"}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-xl md:-translate-x-1/2"
          data-testid="studio-model-sheet"
        >
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
          <SheetHeader className="gap-1 px-4 pt-3 pb-2">
            <SheetTitle className="text-base">AI for this project</SheetTitle>
            <SheetDescription className="text-xs">It uses your own key: pick who answers, then the model.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border px-4 pt-3 pb-5">
            <h3 className="pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Provider</h3>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="AI provider">
              {STUDIO_AI_PROVIDERS.map((id) => {
                const selected = id === provider;
                const label = keyLabel(keys.find((key) => key.provider === id));
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => {
                      if (selected) return;
                      haptic("tick");
                      onChange({ provider: id, model: STUDIO_AI_PROVIDER_INFO[id].defaultModel });
                    }}
                    className={cn(
                      "flex min-h-14 min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors duration-(--motion-duration-fast)",
                      selected ? "border-foreground bg-accent/60" : "border-border hover:bg-accent/40",
                    )}
                    data-provider={id}
                  >
                    <ModelLogo provider={logoProvider(id)} modelId={STUDIO_AI_PROVIDER_INFO[id].defaultModel} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{shortName(id)}</span>
                      <span className={cn("flex items-center gap-1 truncate text-xs", label ? "text-foreground/80" : "text-muted-foreground")}>
                        {label ? <Check className="size-3 shrink-0" aria-hidden="true" /> : <KeyRound className="size-3 shrink-0" aria-hidden="true" />}
                        {label ?? "Needs a key"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <h3 className="pt-4 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Model</h3>
            {models.length ? (
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" role="radiogroup" aria-label="Model">
                {models.map((id) => {
                  const selected = id === model;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => {
                          haptic("tick");
                          onChange({ provider, model: id });
                          setOpen(false);
                        }}
                        className="flex min-h-12 w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-accent/40"
                        data-model-id={id}
                      >
                        <ModelLogo modelId={id} size="sm" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium">{modelDisplayName(id)}</span>
                          <span className="truncate font-mono text-xs text-muted-foreground">{id}</span>
                        </span>
                        {selected ? <Check className="size-4 shrink-0" aria-label="Selected" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Input
                aria-label="Model name"
                placeholder="Model name, e.g. llama-3.3-70b"
                value={model}
                onChange={(event) => onChange({ provider, model: event.target.value })}
                className="h-11 font-mono text-sm"
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
