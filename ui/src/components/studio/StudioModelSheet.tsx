import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Gift, KeyRound, Plus, Users, X } from "lucide-react";
import {
  STUDIO_AI_PROVIDERS,
  STUDIO_AI_PROVIDER_INFO,
  STUDIO_MAX_TEAMMATES,
  type StudioAiKeyStatus,
  type StudioAiProvider,
  type StudioTeammate,
} from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { ModelLogo } from "@/components/ModelLogo";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { haptic } from "@/lib/haptics";
import { modelDisplayName, type ModelProvider } from "@/lib/model-brand";
import { handleRadioGroupKeyDown, radioTabIndex } from "@/lib/radio-group-keys";
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
    case "moonshot":
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
  if (status.provider === "free") return "No key needed";
  return status.source === "automa" ? "Organization key" : "Key saved";
}

/** The logo for a provider tile: the free models show the model's maker, not a generic mark. */
function providerLogoProps(id: StudioAiProvider) {
  return id === "free" ? { modelId: STUDIO_AI_PROVIDER_INFO.free.defaultModel } : { provider: logoProvider(id), modelId: STUDIO_AI_PROVIDER_INFO[id].defaultModel };
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
  team = [],
  onTeamChange,
  companyId,
}: {
  provider: StudioAiProvider;
  model: string;
  keys: StudioAiKeyStatus[];
  onChange: (next: { provider: StudioAiProvider; model: string }) => void;
  /** Models the lead hands tasks to; each needs its provider's key. */
  team?: StudioTeammate[];
  onTeamChange?: (team: StudioTeammate[]) => void;
  /** Lets the OpenRouter provider search its whole catalog. */
  companyId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const info = STUDIO_AI_PROVIDER_INFO[provider];
  // OpenRouter routes hundreds of models; the catalog gives the whole list
  // to search, on top of the short list of well-known ones.
  const catalog = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId ?? "", "opencode_local", null, "openrouter"),
    queryFn: () => agentsApi.adapterModels(companyId!, "opencode_local", { provider: "openrouter" }),
    enabled: open && provider === "openrouter" && Boolean(companyId),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const catalogIds = useMemo(
    () => (catalog.data ?? []).map((entry) => entry.id.replace(/^openrouter\//, "")).filter((id) => !info.models.includes(id)),
    [catalog.data, info.models],
  );
  const needle = search.trim().toLowerCase();
  const models = useMemo(() => {
    const base = info.models.includes(model) || !model ? [...info.models] : [model, ...info.models];
    const extra = provider === "openrouter" ? catalogIds : [];
    const all = needle ? [...base, ...extra].filter((id) => id.toLowerCase().includes(needle)) : needle === "" && provider === "openrouter" ? base : base;
    return all.slice(0, 80);
  }, [info.models, model, provider, catalogIds, needle]);
  const status = keys.find((key) => key.provider === provider);
  const inTeam = (id: string) => team.some((mate) => mate.provider === provider && mate.model === id);
  const addToTeam = (id: string) => {
    if (!onTeamChange || inTeam(id) || team.length >= STUDIO_MAX_TEAMMATES) return;
    haptic("tick");
    onTeamChange([...team, { provider, model: id }]);
  };
  const removeFromTeam = (mate: StudioTeammate) => {
    if (!onTeamChange) return;
    haptic("tick");
    onTeamChange(team.filter((m) => !(m.provider === mate.provider && m.model === mate.model)));
  };
  const chooseProvider = (id: StudioAiProvider) => {
    if (id === provider) return;
    haptic("tick");
    onChange({ provider: id, model: STUDIO_AI_PROVIDER_INFO[id].defaultModel });
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          haptic("tick");
          setOpen(true);
        }}
        className="flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-left transition-colors duration-(--motion-duration-fast) hover:bg-accent/40"
        aria-label={`AI model: ${modelDisplayName(model)} from ${shortName(provider)}. Change`}
        data-testid="studio-model-button"
      >
        <ModelLogo modelId={model} provider={provider === "anthropic" || provider === "openai" || provider === "free" ? undefined : logoProvider(provider)} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{model ? modelDisplayName(model) : "Pick a model"}</span>
          <span className="truncate text-xs text-muted-foreground">
            {shortName(provider)}
            {keyLabel(status) ? ` · ${keyLabel(status)}` : " · Add a key to start"}
            {team.length ? ` · +${team.length} teammate${team.length === 1 ? "" : "s"}` : ""}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-xl md:-translate-x-1/2"
          data-testid="studio-model-sheet"
          // No SheetTrigger, so focus is sent back to the button by hand.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            buttonRef.current?.focus();
          }}
        >
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
          <SheetHeader className="gap-1 px-4 pt-3 pb-2">
            <SheetTitle className="text-base">AI for this project</SheetTitle>
            <SheetDescription className="text-xs">Pick who answers, then the model. The free models need no key. Add teammates and the lead hands them tasks.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border px-4 pt-3 pb-5">
            <h3 className="pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Provider</h3>
            <div
              className="grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label="AI provider"
              onKeyDown={(event) => handleRadioGroupKeyDown(event, (index) => chooseProvider(STUDIO_AI_PROVIDERS[index]))}
            >
              {STUDIO_AI_PROVIDERS.map((id, index) => {
                const selected = id === provider;
                const label = keyLabel(keys.find((key) => key.provider === id));
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={radioTabIndex(selected, index, true)}
                    onClick={() => chooseProvider(id)}
                    className={cn(
                      "flex min-h-14 min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors duration-(--motion-duration-fast)",
                      selected ? "border-foreground bg-accent/60" : "border-border hover:bg-accent/40",
                    )}
                    data-provider={id}
                  >
                    <ModelLogo {...providerLogoProps(id)} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{shortName(id)}</span>
                      <span className={cn("flex items-center gap-1 truncate text-xs", label ? "text-foreground/80" : "text-muted-foreground")}>
                        {id === "free" ? <Gift className="size-3 shrink-0" aria-hidden="true" /> : label ? <Check className="size-3 shrink-0" aria-hidden="true" /> : <KeyRound className="size-3 shrink-0" aria-hidden="true" />}
                        {label ?? "Needs a key"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {onTeamChange ? (
              <div className="pt-4" data-testid="studio-team">
                <h3 className="flex items-center gap-1.5 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Users className="size-3.5" aria-hidden="true" /> Team
                </h3>
                <p className="pb-2 text-xs text-muted-foreground">
                  {team.length
                    ? "The lead model hands these models tasks while it keeps the plan; they report back in the chat."
                    : `Add up to ${STUDIO_MAX_TEAMMATES} models with the + beside a model. The lead hands them tasks (a part of the app each, a review) and reviews their work.`}
                </p>
                {team.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {team.map((mate) => {
                      const ready = keys.find((key) => key.provider === mate.provider)?.connected;
                      return (
                        <span key={`${mate.provider}:${mate.model}`} className="inline-flex items-center gap-1 rounded-full border border-border bg-card py-0.5 pl-1 pr-1 text-xs" data-testid="studio-teammate">
                          <ModelLogo modelId={mate.model} size="xs" tile={false} />
                          <span className="max-w-36 truncate">{modelDisplayName(mate.model)}</span>
                          <span className="text-muted-foreground">· {shortName(mate.provider)}{ready ? "" : " · needs a key"}</span>
                          <button type="button" aria-label={`Remove ${modelDisplayName(mate.model)} from the team`} className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => removeFromTeam(mate)}>
                            <X className="size-3" aria-hidden="true" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            <h3 className="pt-4 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Model</h3>
            {info.models.length ? (
              <Input
                aria-label="Search models"
                placeholder={provider === "openrouter" ? (catalog.isPending ? "Search models (loading the catalog…)" : `Search ${info.models.length + catalogIds.length} models`) : "Search models"}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="mb-2 h-10 text-sm"
              />
            ) : null}
            {info.models.length ? (
              // A div, not a list: a radiogroup's children must be radios.
              <div
                className="flex flex-col divide-y divide-border rounded-lg border border-border"
                role="radiogroup"
                aria-label="Model"
                // Arrows pick a model and keep the sheet open; a tap or Enter
                // picks it and closes the sheet.
                onKeyDown={(event) => handleRadioGroupKeyDown(event, (index) => onChange({ provider, model: models[index] }))}
              >
                {models.map((id, index) => {
                  const selected = id === model;
                  const teamed = inTeam(id);
                  return (
                    <div key={id} className="flex items-stretch">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={radioTabIndex(selected, index, models.includes(model))}
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
                      {onTeamChange && !selected ? (
                        <button
                          type="button"
                          aria-label={teamed ? `${modelDisplayName(id)} is on the team` : `Add ${modelDisplayName(id)} to the team`}
                          aria-pressed={teamed}
                          disabled={teamed || team.length >= STUDIO_MAX_TEAMMATES}
                          onClick={() => addToTeam(id)}
                          className={cn("inline-flex w-11 shrink-0 items-center justify-center border-l border-border text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-50", teamed && "text-primary")}
                          data-testid="studio-add-teammate"
                        >
                          {teamed ? <Users className="size-4" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Model name"
                  placeholder="Model name, e.g. llama-3.3-70b"
                  value={model}
                  onChange={(event) => onChange({ provider, model: event.target.value })}
                  className="h-11 font-mono text-sm"
                />
                {onTeamChange && model.trim() ? (
                  <button type="button" aria-label={`Add ${model.trim()} to the team`} disabled={inTeam(model.trim()) || team.length >= STUDIO_MAX_TEAMMATES} onClick={() => addToTeam(model.trim())} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-accent/40 disabled:opacity-50">
                    <Plus className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
