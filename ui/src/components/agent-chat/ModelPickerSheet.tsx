import { useMemo, useState, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Gift, KeyRound, Loader2, Search, Sparkles } from "lucide-react";
import { aiConnectionBindingSchema, FREE_MODELS_ADAPTER_TYPE, type Agent, type AiProvider } from "@paperclipai/shared";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { aiConnectionsApi } from "@/api/ai-connections";
import { freeModelsApi } from "@/api/free-models";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { ModelLogo } from "@/components/ModelLogo";
import { ByokKeysCard, connectKeyHref } from "./ByokKeysCard";
import { ThinkingDepthControl, currentThinkingLevel, thinkingLevelPatch, thinkingLevelsFor } from "./ThinkingDepthControl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { MODEL_PROVIDERS, NEWEST_MODEL_IDS, modelDisplayName, modelProvider, providerBrand, type ModelProvider } from "@/lib/model-brand";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/** Models shown per maker before "Show all"; searching or filtering shows every match. */
const COLLAPSED_ROWS = 4;

interface ModelEntry {
  id: string;
  name: string;
  provider: ModelProvider;
  /** `runtime`: the agent's current runtime; `openrouter`: any model through your OpenRouter key; `free`: free models, no key. */
  source: "runtime" | "openrouter" | "free";
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
      {entry.source === "free" ? <Badge variant="secondary" data-slot="free-tag">Free</Badge> : null}
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

const smallUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 2 });
const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (value: number) => (value > 0 && value < 0.01 ? smallUsd : wholeUsd).format(value);

/** Tokens and images spent on free models, what paid prices would have charged, and a reset. */
function FreeUsageCard({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const usage = useQuery({
    queryKey: queryKeys.freeModels.usage(companyId),
    queryFn: () => freeModelsApi.usage(companyId),
  });
  const reset = useMutation({
    mutationFn: () => freeModelsApi.resetUsage(companyId),
    onSuccess: (data) => {
      haptic("success");
      client.setQueryData(queryKeys.freeModels.usage(companyId), data);
      pushToast({ title: "Free usage reset", tone: "success" });
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn’t reset free usage", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });
  if (usage.error) {
    return <p className="mx-1 mb-2 px-3 text-xs text-destructive">{usage.error instanceof Error ? usage.error.message : "Could not load free usage."}</p>;
  }
  if (!usage.data) return null;
  const { inputTokens, outputTokens, images, equivalentUsd, since } = usage.data;
  const tokens = inputTokens + outputTokens;
  return (
    <div data-testid="free-usage" className="mx-1 mb-2 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <div className="min-w-0 flex-1 text-xs">
        <p className="font-medium text-foreground">
          {tokens.toLocaleString()} tokens{images ? ` · ${images} ${images === 1 ? "image" : "images"}` : ""} · $0.00 charged
        </p>
        <p className="text-muted-foreground">
          Would have cost {usd(equivalentUsd)} at paid prices{since ? ` · since ${new Date(since).toLocaleDateString()}` : ""}
        </p>
      </div>
      <Button variant="outline" size="sm" disabled={reset.isPending || (tokens === 0 && images === 0)} onClick={() => reset.mutate()}>
        {reset.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
        Reset
      </Button>
    </div>
  );
}

/** Reads a config toggle that defaults to on. */
function toggleOn(value: unknown): boolean {
  return value !== false && value !== "off" && value !== "false" && value !== "none";
}

const FREE_TOOL_ROWS: { key: string; label: string; hint: string }[] = [
  { key: "freeWeb", label: "Web search & reading", hint: "Search the web and read pages" },
  { key: "freeFiles", label: "Files & commands", hint: "Read and change files, run commands" },
  { key: "freeTeammates", label: "Teammates & tasks", hint: "Message agents, create and update tasks, write plans" },
  { key: "freeConnections", label: "Connected apps", hint: "Use Gmail, Slack, GitHub and more" },
];

/** Tools and a paired image model for an agent running on a free chat model. */
function FreeToolsPanel({ agent, imageOptions }: { agent: Agent; imageOptions: { id: string; name: string }[] }) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const boundImage = typeof config.imageModel === "string" ? config.imageModel : "";

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => agentsApi.update(agent.id, { adapterConfig: patch }, agent.companyId),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) }),
        client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
      ]);
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn’t change the setting", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  return (
    <div data-testid="free-tools" className="mx-1 mb-2 rounded-lg border border-border bg-card px-3 py-2.5">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">What this agent can do</h4>
      <div className="flex flex-col gap-2.5">
        {FREE_TOOL_ROWS.map((row) => (
          <label key={row.key} className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-sm text-foreground">{row.label}</span>
              <span className="block text-xs text-muted-foreground">{row.hint}</span>
            </span>
            <ToggleSwitch
              checked={toggleOn(config[row.key])}
              disabled={update.isPending}
              onCheckedChange={(next) => { haptic("tick"); update.mutate({ [row.key]: next }); }}
              aria-label={row.label}
            />
          </label>
        ))}
      </div>
      {imageOptions.length ? (
        <div className="mt-3 border-t border-border pt-2.5">
          <div className="mb-1.5 text-sm text-foreground">Paired image model</div>
          <div className="mb-1.5 text-xs text-muted-foreground">The agent can draw pictures in its replies with this model.</div>
          <div className="flex flex-wrap gap-1.5">
            {[{ id: "", name: "None" }, ...imageOptions].map((option) => (
              <button
                key={option.id || "none"}
                type="button"
                aria-pressed={boundImage === option.id}
                disabled={update.isPending}
                onClick={() => { haptic("tick"); update.mutate({ imageModel: option.id }); }}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  boundImage === option.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-accent",
                )}
              >
                {option.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ModelPickerSheet({ agent, open, onOpenChange, initialQuery = "", returnFocusRef }: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Search text to open with (from `/model <name>`). */
  initialQuery?: string;
  /** Where focus goes when the sheet closes (it has no trigger of its own). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const companyId = agent.companyId;
  const currentModel = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const binding = aiConnectionBindingSchema.safeParse((agent.runtimeConfig as Record<string, unknown> | undefined)?.aiConnection).data;
  const runsOnOpenRouter = agent.adapterType === "opencode_local" && binding?.provider === "openrouter";
  const runsFree = agent.adapterType === FREE_MODELS_ADAPTER_TYPE;
  const [query, setQuery] = useState(initialQuery);
  // Each time the sheet opens, it starts from the search it was opened with.
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  const openKey = open ? initialQuery : null;
  if (openKey !== openedWith) {
    setOpenedWith(openKey);
    if (open) setQuery(initialQuery);
  }
  const [filter, setFilter] = useState<ModelProvider | "all" | "free">("all");
  const [expanded, setExpanded] = useState<Set<ModelProvider>>(() => new Set());

  const runtimeModels = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, agent.adapterType, null),
    queryFn: () => agentsApi.adapterModels(companyId, agent.adapterType),
    enabled: open && !runsOnOpenRouter && !runsFree,
    staleTime: 5 * 60_000,
  });
  const freeModels = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, FREE_MODELS_ADAPTER_TYPE, null),
    queryFn: () => agentsApi.adapterModels(companyId, FREE_MODELS_ADAPTER_TYPE),
    enabled: open,
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
    () => (runsOnOpenRouter || runsFree ? [] : toEntries(runtimeModels.data, "runtime", agent.adapterType)),
    [runsOnOpenRouter, runsFree, runtimeModels.data, agent.adapterType],
  );
  const freeEntries = useMemo(() => toEntries(freeModels.data, "free", FREE_MODELS_ADAPTER_TYPE), [freeModels.data]);
  const freeImageOptions = useMemo(
    () => (freeModels.data ?? []).filter((model) => model.id.startsWith("@cf/")).map((model) => ({ id: model.id, name: modelDisplayName(model.id, model.label).replace(/ · image$/i, "") })),
    [freeModels.data],
  );
  const runsFreeChat = runsFree && !currentModel.startsWith("@cf/");
  const catalogEntries = useMemo(
    () => toEntries(catalog.data, "openrouter", "opencode_local").sort(byRecency),
    [catalog.data],
  );
  const newest = useMemo(
    () => NEWEST_MODEL_IDS.flatMap((id) => catalogEntries.filter((entry) => entry.id.replace(/^openrouter\//, "") === id)),
    [catalogEntries],
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
  const visibleFree = freeEntries.filter((entry) => matches(entry, query) && (filter === "all" || filter === "free" || entry.provider === filter));
  const visibleGroups = groups
    .filter((group) => filter === "all" || group.provider === filter)
    .map((group) => ({ ...group, entries: group.entries.filter((entry) => matches(entry, query)) }))
    .filter((group) => group.entries.length > 0);

  const select = useMutation({
    mutationFn: async (entry: ModelEntry) => {
      if (entry.source === "free") {
        if (runsFree) return agentsApi.update(agent.id, { adapterConfig: { model: entry.id } }, companyId);
        // Free models need no key, so the switch drops any key binding.
        const runtimeConfig = { ...((agent.runtimeConfig as Record<string, unknown> | undefined) ?? {}) };
        delete runtimeConfig.aiConnection;
        return agentsApi.update(agent.id, { adapterType: FREE_MODELS_ADAPTER_TYPE, adapterConfig: { model: entry.id }, runtimeConfig }, companyId);
      }
      if (entry.source === "runtime" || runsOnOpenRouter) {
        // A thinking level the new model doesn't take is cleared with the switch.
        const level = currentThinkingLevel(agent);
        const keepsLevel = !level || thinkingLevelsFor({ ...agent, adapterConfig: { ...agent.adapterConfig, model: entry.id } }).includes(level);
        return agentsApi.update(
          agent.id,
          { adapterConfig: { model: entry.id, ...(keepsLevel ? {} : thinkingLevelPatch(agent, "")) } },
          companyId,
        );
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
    if (entry.id === currentModel && (entry.source !== "free" || runsFree)) return;
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
    for (const entry of [...runtimeEntries, ...freeEntries, ...catalogEntries]) counts.set(entry.provider, (counts.get(entry.provider) ?? 0) + 1);
    return counts;
  }, [runtimeEntries, freeEntries, catalogEntries]);
  const chipProviders = MODEL_PROVIDERS.filter((provider) => provider !== "other" && (providerCounts.get(provider) ?? 0) > 0);
  const totalCount = runtimeEntries.length + freeEntries.length + catalogEntries.length;
  const busyId = select.isPending ? select.variables?.id : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-xl md:-translate-x-1/2"
        data-testid="model-picker-sheet"
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
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

        <ThinkingDepthControl agent={agent} className="px-4 pb-3" />
        {runsFreeChat ? <FreeToolsPanel agent={agent} imageOptions={freeImageOptions} /> : null}

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
            {freeEntries.length ? (
              <ProviderChip label="Free" count={freeEntries.length} active={filter === "free"} onClick={() => setFilter(filter === "free" ? "all" : "free")} />
            ) : null}
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
            <div className="space-y-2 px-3 py-2" role="status" aria-busy="true" aria-label="Loading models">
              {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-12 w-full rounded-lg" />)}
            </div>
          ) : null}

          {visibleFree.length > 0 ? (
            <section aria-label="Free models" className="pb-2" data-testid="free-models">
              <h3 className="flex items-center gap-1.5 px-3 pt-1 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Gift className="size-3.5" aria-hidden="true" />
                Free models · no key needed
              </h3>
              <FreeUsageCard companyId={companyId} />
              {visibleFree.map((entry) => (
                <ModelRow
                  key={`free-${entry.id}`}
                  entry={entry}
                  current={runsFree && entry.id === currentModel}
                  locked={false}
                  busy={busyId === entry.id}
                  onSelect={choose}
                />
              ))}
            </section>
          ) : null}

          {!searching && filter === "all" && newest.length > 0 ? (
            <section aria-label="Newest models" className="pb-2" data-testid="newest-models">
              <h3 className="flex items-center gap-1.5 px-3 pt-1 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Sparkles className="size-3.5" aria-hidden="true" />
                Newest models
              </h3>
              {newest.map((entry) => (
                <ModelRow
                  key={`newest-${entry.id}`}
                  entry={entry}
                  current={entry.id === currentModel}
                  locked={!hasOpenRouterKey && !runsOnOpenRouter}
                  busy={busyId === entry.id}
                  onSelect={choose}
                />
              ))}
            </section>
          ) : null}

          {filter === "free" ? null : <section aria-label="Models with your OpenRouter key" className="pt-1">
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
            {!catalog.isPending && !catalog.error && visibleGroups.length === 0 && visibleRuntime.length === 0 && visibleFree.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No models match “{query}”.</p>
            ) : null}
          </section>}

          <ByokKeysCard connected={connected} className="mx-1 mt-4" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
