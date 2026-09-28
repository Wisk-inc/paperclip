import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Loader2, Search } from "lucide-react";
import { aiConnectionBindingSchema, type Agent, type AiProvider } from "@paperclipai/shared";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { aiConnectionsApi } from "@/api/ai-connections";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { ModelLogo } from "@/components/ModelLogo";
import { ByokKeysCard, connectKeyHref } from "./ByokKeysCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { MODEL_PROVIDERS, modelDisplayName, modelProvider, providerBrand, type ModelProvider } from "@/lib/model-brand";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/** Models shown per maker before "Show all"; searching or filtering shows every match. */
const COLLAPSED_ROWS = 4;

interface ModelEntry {
  id: string;
  name: string;
  provider: ModelProvider;
  /** `runtime`: the agent's current runtime; `openrouter`: any model through your OpenRouter key. */
  source: "runtime" | "openrouter";
}

function toEntries(models: AdapterModel[] | undefined, source: ModelEntry["source"], adapterType: string): ModelEntry[] {
  return (models ?? []).map((model) => ({
    id: model.id,
    name: modelDisplayName(model.id, model.label),
    provider: modelProvider(model.id, adapterType),
    source,
  }));
}

/** The model's main version ("DeepSeek V4.1 Flash" → 4.1, "R1 0528" → 1), ignoring dates and sizes. */
export function modelVersion(name: string): number {
  for (const match of name.matchAll(/(\d+(?:\.\d+)?)/g)) {
    const digits = match[1]!;
    const next = name.charAt((match.index ?? 0) + digits.length).toLowerCase();
    // Skip date stamps ("0528", "2025") and parameter sizes ("70B").
    if (/^\d{4,}$/.test(digits) || next === "b") continue;
    return Number(digits);
  }
  return 0;
}

/** Newest first ("V4.1" before "V4" before "R1"), with batch and free variants after the base model. */
export function byRecency(a: { id: string; name: string }, b: { id: string; name: string }) {
  const variantA = a.id.includes(":") ? 1 : 0;
  const variantB = b.id.includes(":") ? 1 : 0;
  if (variantA !== variantB) return variantA - variantB;
  const version = modelVersion(b.name) - modelVersion(a.name);
  if (version !== 0) return version;
  return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: "base" });
}

function matches(entry: ModelEntry, query: string) {
  if (!query) return true;
  const haystack = `${entry.name} ${entry.id} ${providerBrand(entry.provider).providerName}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
}

function ModelRow({ entry, current, locked, busy, onSelect }: {
  entry: ModelEntry;
  current: boolean;
  locked: boolean;
  busy: boolean;
  onSelect: (entry: ModelEntry) => void;
}) {
  return (
    <button
      type="button"
      data-slot="model-row"
      data-model-id={entry.id}
      aria-pressed={current}
      disabled={busy}
      onClick={() => onSelect(entry)}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
        "hover:bg-accent/60 active:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
        current && "bg-accent",
      )}
    >
      <ModelLogo modelId={entry.id} provider={entry.provider === "other" ? undefined : entry.provider} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{entry.name}</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">{entry.id}</span>
      </span>
      {current ? <Check className="size-4 shrink-0 text-primary" aria-label="Current model" /> : null}
      {!current && locked ? <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-label="Needs your OpenRouter key" /> : null}
    </button>
  );
}

function ProviderChip({ provider, label, count, active, onClick }: {
  provider?: ModelProvider;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-sm transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-accent",
      )}
    >
      {provider ? <ModelLogo provider={provider} size="xs" tile={false} /> : null}
      <span className="whitespace-nowrap">{label}</span>
      <span className={cn("text-xs tabular-nums", active ? "text-primary-foreground/80" : "text-muted-foreground")}>{count}</span>
    </button>
  );
}

export function ModelPickerSheet({ agent, open, onOpenChange }: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const companyId = agent.companyId;
  const currentModel = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const binding = aiConnectionBindingSchema.safeParse((agent.runtimeConfig as Record<string, unknown> | undefined)?.aiConnection).data;
  const runsOnOpenRouter = agent.adapterType === "opencode_local" && binding?.provider === "openrouter";
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelProvider | "all">("all");
  const [expanded, setExpanded] = useState<Set<ModelProvider>>(() => new Set());

  const runtimeModels = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, agent.adapterType, null),
    queryFn: () => agentsApi.adapterModels(companyId, agent.adapterType),
    enabled: open && !runsOnOpenRouter,
    staleTime: 5 * 60_000,
  });
  const catalog = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, "opencode_local", null, "openrouter"),
    queryFn: () => agentsApi.adapterModels(companyId, "opencode_local", { provider: "openrouter" }),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const connections = useQuery({
    queryKey: ["ai-connections", companyId, agent.id],
    queryFn: () => aiConnectionsApi.list(companyId, agent.id),
    enabled: open,
  });
  const connected = useMemo(() => {
    const providers = new Set<AiProvider>();
    for (const connection of connections.data?.connections ?? []) {
      if (connection.status === "connected") providers.add(connection.provider);
    }
    return providers;
  }, [connections.data]);
  const hasOpenRouterKey = connected.has("openrouter");

  const runtimeEntries = useMemo(
    () => (runsOnOpenRouter ? [] : toEntries(runtimeModels.data, "runtime", agent.adapterType)),
    [runsOnOpenRouter, runtimeModels.data, agent.adapterType],
  );
  const catalogEntries = useMemo(
    () => toEntries(catalog.data, "openrouter", "opencode_local").sort(byRecency),
    [catalog.data],
  );
  const groups = useMemo(() => {
    const byProvider = new Map<ModelProvider, ModelEntry[]>();
    for (const entry of catalogEntries) {
      const list = byProvider.get(entry.provider) ?? [];
      list.push(entry);
      byProvider.set(entry.provider, list);
    }
    return MODEL_PROVIDERS.flatMap((provider) => {
      const entries = byProvider.get(provider);
      return entries?.length ? [{ provider, entries }] : [];
    });
  }, [catalogEntries]);

  const searching = query.trim().length > 0;
  const visibleRuntime = runtimeEntries.filter((entry) => matches(entry, query) && (filter === "all" || entry.provider === filter));
  const visibleGroups = groups
    .filter((group) => filter === "all" || group.provider === filter)
    .map((group) => ({ ...group, entries: group.entries.filter((entry) => matches(entry, query)) }))
    .filter((group) => group.entries.length > 0);

  const select = useMutation({
    mutationFn: async (entry: ModelEntry) => {
      if (entry.source === "runtime" || runsOnOpenRouter) {
        return agentsApi.update(agent.id, { adapterConfig: { model: entry.id } }, companyId);
      }
      // Any model through your own OpenRouter key runs on the OpenCode runtime.
      return agentsApi.update(agent.id, {
        adapterType: "opencode_local",
        adapterConfig: { model: entry.id },
        runtimeConfig: {
          ...((agent.runtimeConfig as Record<string, unknown> | undefined) ?? {}),
          aiConnection: { provider: "openrouter", method: "api_key", mode: "responsible_user" },
        },
      }, companyId);
    },
    onSuccess: async (_updated, entry) => {
      haptic("success");
      pushToast({ title: `${agent.name} now uses ${entry.name}`, tone: "success" });
      onOpenChange(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
      ]);
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn’t switch the model", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  const choose = (entry: ModelEntry) => {
    if (entry.id === currentModel) return;
    if (entry.source === "openrouter" && !hasOpenRouterKey && !runsOnOpenRouter) {
      haptic("warning");
      pushToast({
        title: "Add your OpenRouter key first",
        body: `Then pick ${entry.name} again. One key covers every model in this list.`,
        tone: "info",
        action: { label: "Add key", href: connectKeyHref("openrouter") },
      });
      return;
    }
    haptic("tick");
    select.mutate(entry);
  };

  const providerCounts = useMemo(() => {
    const counts = new Map<ModelProvider, number>();
    for (const entry of [...runtimeEntries, ...catalogEntries]) counts.set(entry.provider, (counts.get(entry.provider) ?? 0) + 1);
    return counts;
  }, [runtimeEntries, catalogEntries]);
  const chipProviders = MODEL_PROVIDERS.filter((provider) => provider !== "other" && (providerCounts.get(provider) ?? 0) > 0);
  const totalCount = runtimeEntries.length + catalogEntries.length;
  const busyId = select.isPending ? select.variables?.id : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-xl md:-translate-x-1/2"
        data-testid="model-picker-sheet"
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
        <SheetHeader className="gap-1 px-4 pt-3 pb-2">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ModelLogo modelId={currentModel} adapterType={agent.adapterType} size="sm" />
            Model for {agent.name}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Now: <span className="font-medium text-foreground">{modelDisplayName(currentModel)}</span>
            {" · "}{getAdapterLabel(agent.adapterType)}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-2 px-4 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={totalCount ? `Search ${totalCount} models` : "Search models"}
              aria-label="Search models"
              className="h-10 pl-9"
            />
          </div>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="group" aria-label="Filter by maker">
            <ProviderChip label="All" count={totalCount} active={filter === "all"} onClick={() => setFilter("all")} />
            {chipProviders.map((provider) => (
              <ProviderChip
                key={provider}
                provider={provider}
                label={providerBrand(provider).providerName}
                count={providerCounts.get(provider) ?? 0}
                active={filter === provider}
                onClick={() => setFilter(filter === provider ? "all" : provider)}
              />
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border px-2 pt-2 pb-4">
          {!runsOnOpenRouter && visibleRuntime.length > 0 ? (
            <section aria-label={`${getAdapterLabel(agent.adapterType)} models`} className="pb-2">
              <h3 className="px-3 pt-1 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                On {getAdapterLabel(agent.adapterType)}
              </h3>
              {visibleRuntime.map((entry) => (
                <ModelRow key={entry.id} entry={entry} current={entry.id === currentModel} locked={false} busy={busyId === entry.id} onSelect={choose} />
              ))}
            </section>
          ) : null}
          {!runsOnOpenRouter && runtimeModels.isPending && open ? (
            <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading {getAdapterLabel(agent.adapterType)} models…</p>
          ) : null}

          <section aria-label="Models with your OpenRouter key" className="pt-1">
            <div className="flex items-center justify-between gap-2 px-3 pt-1 pb-1">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {runsOnOpenRouter ? "With your OpenRouter key" : "Every model · your OpenRouter key"}
              </h3>
              {!hasOpenRouterKey && !runsOnOpenRouter ? (
                <Link to={connectKeyHref("openrouter")} className="text-xs font-medium text-primary">Add key</Link>
              ) : null}
            </div>
            {catalog.isPending ? (
              <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading models from OpenRouter…</p>
            ) : null}
            {catalog.error ? (
              <div className="mx-1 rounded-lg border border-border bg-card p-3 text-sm">
                <p className="text-destructive">{catalog.error instanceof Error ? catalog.error.message : "Could not load OpenRouter models."}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => void catalog.refetch()}>Retry</Button>
              </div>
            ) : null}
            {visibleGroups.map(({ provider, entries }) => {
              const showAll = searching || filter !== "all" || expanded.has(provider);
              const shown = showAll ? entries : entries.slice(0, COLLAPSED_ROWS);
              const brand = providerBrand(provider);
              return (
                <div key={provider} className="pt-2" data-provider-group={provider}>
                  <div className="flex items-center gap-2 px-3 pb-1">
                    <ModelLogo provider={provider} size="xs" tile={false} />
                    <span className="text-sm font-semibold text-foreground">{provider === "other" ? "More makers" : brand.providerName}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{entries.length}</span>
                  </div>
                  {shown.map((entry) => (
                    <ModelRow
                      key={entry.id}
                      entry={entry}
                      current={entry.id === currentModel}
                      locked={!hasOpenRouterKey && !runsOnOpenRouter}
                      busy={busyId === entry.id}
                      onSelect={choose}
                    />
                  ))}
                  {!showAll && entries.length > COLLAPSED_ROWS ? (
                    <button
                      type="button"
                      className="ml-14 py-1.5 text-xs font-medium text-primary"
                      onClick={() => setExpanded((previous) => new Set(previous).add(provider))}
                    >
                      Show all {entries.length} {brand.providerName} models
                    </button>
                  ) : null}
                </div>
              );
            })}
            {!catalog.isPending && !catalog.error && visibleGroups.length === 0 && visibleRuntime.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No models match “{query}”.</p>
            ) : null}
          </section>

          <ByokKeysCard connected={connected} className="mx-1 mt-4" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
