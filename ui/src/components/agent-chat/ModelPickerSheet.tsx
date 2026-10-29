import { useMemo, useState, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Gift, KeyRound, Loader2, Search, Sparkles, Zap } from "lucide-react";
import { aiConnectionBindingSchema, FREE_IMAGE_MODEL_NONE, FREE_MODELS_ADAPTER_TYPE, MOAN_BLURB, MOAN_MODEL_ID, isMoanModel, pairedFreeImageModel, resolveFreeModel, type Agent, type AiProvider, type FreeModelHealthEntry } from "@paperclipai/shared";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { aiConnectionsApi } from "@/api/ai-connections";
import { freeModelsApi } from "@/api/free-models";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { ModelLogo } from "@/components/ModelLogo";
import { isServerTooOld, retryUnlessServerTooOld } from "@/components/device/PhoneServerOutdated";
import { ByokKeysCard, connectKeyHref } from "./ByokKeysCard";
import { ThinkingDepthControl, currentThinkingLevel, thinkingLevelPatch, thinkingLevelsFor } from "./ThinkingDepthControl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { BondedModelLogos } from "@/components/BondedModelLogos";
import { patchAgentCache } from "@/lib/optimistic-agent";
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

interface ModelSwitch {
  entry: ModelEntry;
  patch: { adapterType?: Agent["adapterType"]; adapterConfig: Record<string, unknown>; runtimeConfig?: Record<string, unknown> };
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

/** "in 1 h 40 min", for when a model at its daily limit answers again. */
function untilText(until: string | null): string {
  const at = until ? new Date(until).getTime() : NaN;
  if (!Number.isFinite(at)) return "later today";
  const minutes = Math.max(1, Math.ceil((at - Date.now()) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `in ${hours} h${rest ? ` ${rest} min` : ""}`;
}

/** A free model's state in a few words, or null when it is answering normally. */
export function freeHealthNote(health: FreeModelHealthEntry | null | undefined): string | null {
  if (!health || health.state === "ok") return null;
  // A hold whose time has passed is over, as the server counts it; the list
  // may still hold the last refresh, which said otherwise.
  if (health.until && new Date(health.until).getTime() <= Date.now()) return null;
  switch (health.state) {
    case "daily_limit":
      return `Daily free limit reached · back ${untilText(health.until)}`;
    case "busy":
      return "Busy at its provider right now · retried automatically";
    case "restricted":
      return "Its provider is limiting it to partner apps · checked again with each message";
    case "withdrawn":
      return "Offline at its provider · checked again with each message";
    case "charged":
      return "Paused: it started charging";
  }
}

function ModelRow({ entry, current, locked, busy, health, onSelect }: {
  entry: ModelEntry;
  current: boolean;
  locked: boolean;
  busy: boolean;
  health?: FreeModelHealthEntry | null;
  onSelect: (entry: ModelEntry) => void;
}) {
  const note = freeHealthNote(health);
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
        {entry.id === MOAN_MODEL_ID ? (
          <span className="line-clamp-2 text-xs text-muted-foreground" data-slot="model-blurb">{MOAN_BLURB}</span>
        ) : (
          <span className="block truncate font-mono text-xs text-muted-foreground">{entry.id}</span>
        )}
        {note ? <span className="block truncate text-xs text-(--status-agent-paused)" data-slot="model-health" data-state={health?.state}>{note}</span> : null}
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
    retry: retryUnlessServerTooOld,
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
    // A phone server older than the app has no such route: nothing to show rather than an error.
    if (isServerTooOld(usage.error)) return null;
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

/** The Que engine every free model answers through: what it is doing right now. */
function QueEngineStatus({ companyId }: { companyId: string }) {
  const stats = useQuery({
    queryKey: queryKeys.freeModels.que(companyId),
    queryFn: () => freeModelsApi.queStats(companyId),
    retry: retryUnlessServerTooOld,
    refetchInterval: (query) => (isServerTooOld(query.state.error) ? false : 5_000),
  });
  if (stats.error) {
    if (isServerTooOld(stats.error)) return null;
    return <p className="mx-1 mb-2 px-3 text-xs text-destructive">{stats.error instanceof Error ? stats.error.message : "Could not load the Que engine."}</p>;
  }
  if (!stats.data) return null;
  const { inFlight, waiting, maxInFlight, cachedAnswers } = stats.data;
  const now = inFlight === 0 && waiting === 0
    ? `ready · up to ${maxInFlight} answers at once`
    : `${inFlight} answering${waiting ? ` · ${waiting} waiting their turn` : ""}`;
  return (
    <p data-testid="que-engine" className="mx-1 mb-2 flex items-center gap-1.5 px-3 text-xs text-muted-foreground">
      <Zap className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="font-medium text-foreground">Que engine</span>
      <span className="truncate">· {now}{cachedAnswers ? ` · ${cachedAnswers} cached` : ""}</span>
    </p>
  );
}

/** Moan's Jamaican knowledge index: how much it holds, when it last read its sources, and a refresh. */
function MoanKnowledgeCard() {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const status = useQuery({
    queryKey: queryKeys.freeModels.moan(),
    queryFn: () => freeModelsApi.moanStatus(),
    retry: retryUnlessServerTooOld,
    refetchInterval: (query) => (query.state.data?.running ? 10_000 : false),
  });
  const refresh = useMutation({
    mutationFn: () => freeModelsApi.moanRefresh(false),
    onSuccess: (data) => {
      haptic("success");
      client.setQueryData(queryKeys.freeModels.moan(), data.status);
      // Nothing started because a refresh (the schedule's, or Moan's first reply's) is already reading: not "up to date".
      if (!data.started && data.status.running) {
        pushToast({ title: "Still reading Jamaican sources", body: "A refresh is already under way.", tone: "info" });
        return;
      }
      pushToast({ title: data.started ? `Reading ${data.sources} Jamaican source${data.sources === 1 ? "" : "s"}` : "Everything is up to date", tone: "success" });
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn’t refresh Moan’s knowledge", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });
  if (status.error) {
    if (isServerTooOld(status.error)) return null;
    return <p className="mx-1 mb-2 px-3 text-xs text-destructive">{status.error instanceof Error ? status.error.message : "Could not load Moan’s knowledge."}</p>;
  }
  if (!status.data) return null;
  const data = status.data;
  const okSources = data.sources.filter((source) => source.pages > 0).length;
  const failing = data.sources.filter((source) => source.lastError && source.pages === 0).length;
  const refreshed = data.lastFetchedAt ? new Date(data.lastFetchedAt) : null;
  const ago = refreshed ? relativeTime(refreshed) : null;
  return (
    <div data-testid="moan-knowledge" className="mx-1 mb-2 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <ModelLogo modelId={MOAN_MODEL_ID} size="md" />
      <div className="min-w-0 flex-1 text-xs">
        <p className="font-medium text-foreground">
          Jamaica knowledge · {data.pages.toLocaleString()} {data.pages === 1 ? "page" : "pages"} from {okSources} {okSources === 1 ? "source" : "sources"}
        </p>
        <p className="text-muted-foreground">
          {data.running
            ? "Reading Jamaican sources now…"
            : data.pages === 0
              ? data.enabled ? "Fills in the background from the first Moan reply." : "Starts filling once a Moan agent is in use."
              : `Refreshed ${ago}${failing ? ` · ${failing} ${failing === 1 ? "source" : "sources"} unreachable` : ""}`}
        </p>
      </div>
      <Button variant="outline" size="sm" disabled={refresh.isPending || data.running} onClick={() => refresh.mutate()}>
        {refresh.isPending || data.running ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
        Refresh
      </Button>
    </div>
  );
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
function relativeTime(date: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
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
  // Paired by default, so drawing works before anyone opens this panel.
  const boundImage = pairedFreeImageModel(config);

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => agentsApi.update(agent.id, { adapterConfig: patch }, agent.companyId),
    // The switch moves on the tap; the server's answer confirms or undoes it.
    onMutate: (patch) => {
      const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, config[key]]));
      patchAgentCache(client, agent.id, agent.companyId, { adapterConfig: patch });
      return previous;
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) }),
        client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
      ]);
    },
    onError: (error, _patch, previous) => {
      haptic("warning");
      pushToast({ title: "Couldn’t change the setting", body: error instanceof Error ? error.message : String(error), tone: "error" });
      // Put the old value back now: if the reload fails too, the switch must not show a setting the agent doesn't have.
      if (previous) patchAgentCache(client, agent.id, agent.companyId, { adapterConfig: previous });
      void client.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) });
      void client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
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
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-sm text-foreground">Paired image model</span>
            {boundImage ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 py-0.5 pl-1 pr-2 text-xs font-medium text-primary" data-testid="free-bond-mark">
                <BondedModelLogos chatModelId={typeof config.model === "string" ? config.model : ""} imageModelId={boundImage} size="xs" />
                Bonded
              </span>
            ) : null}
          </div>
          <div className="mb-1.5 text-xs text-muted-foreground">Ask for a picture and the agent draws it with this model.</div>
          <div className="flex flex-wrap gap-1.5">
            {[{ id: FREE_IMAGE_MODEL_NONE, name: "None" }, ...imageOptions].map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={option.id === FREE_IMAGE_MODEL_NONE ? !boundImage : boundImage === option.id}
                disabled={update.isPending}
                onClick={() => { haptic("tick"); update.mutate({ imageModel: option.id }); }}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  (option.id === FREE_IMAGE_MODEL_NONE ? !boundImage : boundImage === option.id) ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-accent",
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
  const [filter, setFilter] = useState<ModelProvider | "all" | "free">("all");
  // Each time the sheet opens, it starts from the search it was opened with,
  // across every maker: a chip left on would hide what `/model <name>` asked for.
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  const openKey = open ? initialQuery : null;
  if (openKey !== openedWith) {
    setOpenedWith(openKey);
    if (open) {
      setQuery(initialQuery);
      setFilter("all");
    }
  }
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
  // Which free models are at their daily limit, busy, or closed by their provider; refreshed while the sheet is open.
  const freeHealth = useQuery({
    queryKey: queryKeys.freeModels.health(),
    queryFn: () => freeModelsApi.health(),
    enabled: open,
    retry: retryUnlessServerTooOld,
    refetchInterval: (query) => (open && !isServerTooOld(query.state.error) ? 60_000 : false),
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

  /** The change a tap on `entry` asks the server for, from the agent as it is now. */
  const switchPatch = (entry: ModelEntry): ModelSwitch["patch"] => {
    if (entry.source === "free") {
      if (runsFree) return { adapterConfig: { model: entry.id } };
      // Free models need no key, so the switch drops any key binding.
      const runtimeConfig = { ...((agent.runtimeConfig as Record<string, unknown> | undefined) ?? {}) };
      delete runtimeConfig.aiConnection;
      return { adapterType: FREE_MODELS_ADAPTER_TYPE, adapterConfig: { model: entry.id }, runtimeConfig };
    }
    if (entry.source === "runtime" || runsOnOpenRouter) {
      // A thinking level the new model doesn't take is cleared with the switch.
      const level = currentThinkingLevel(agent);
      const keepsLevel = !level || thinkingLevelsFor({ ...agent, adapterConfig: { ...agent.adapterConfig, model: entry.id } }).includes(level);
      return { adapterConfig: { model: entry.id, ...(keepsLevel ? {} : thinkingLevelPatch(agent, "")) } };
    }
    // Any model through your own OpenRouter key runs on the OpenCode runtime.
    return {
      adapterType: "opencode_local",
      adapterConfig: { model: entry.id },
      runtimeConfig: {
        ...((agent.runtimeConfig as Record<string, unknown> | undefined) ?? {}),
        aiConnection: { provider: "openrouter", method: "api_key", mode: "responsible_user" },
      },
    };
  };

  const select = useMutation({
    // The patch is worked out on the tap and travels with it. A switch held
    // for a connection runs after the sheet has re-rendered with the new
    // model; rebuilt then, a move onto a free model would lose its adapter change.
    mutationFn: ({ patch }: ModelSwitch) => agentsApi.update(agent.id, patch, companyId),
    // The new model shows in the header on the tap, not after the round trip.
    onMutate: ({ entry, patch }) => {
      patchAgentCache(client, agent.id, companyId, { adapterType: patch.adapterType ?? agent.adapterType, adapterConfig: { model: entry.id } });
      return { adapterType: agent.adapterType, model: agent.adapterConfig?.model };
    },
    onSuccess: async (_updated, { entry }) => {
      haptic("success");
      pushToast({ title: `${agent.name} now uses ${entry.name}`, tone: "success" });
      onOpenChange(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
      ]);
    },
    onError: (error, _switch, previous) => {
      haptic("warning");
      pushToast({ title: "Couldn’t switch the model", body: error instanceof Error ? error.message : String(error), tone: "error" });
      // Put the old model back now: if the reload fails too, the header must not name a model the agent isn't on.
      if (previous) patchAgentCache(client, agent.id, companyId, { adapterType: previous.adapterType, adapterConfig: { model: previous.model } });
      void client.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      void client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
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
    select.mutate({ entry, patch: switchPatch(entry) });
  };

  const providerCounts = useMemo(() => {
    const counts = new Map<ModelProvider, number>();
    for (const entry of [...runtimeEntries, ...freeEntries, ...catalogEntries]) counts.set(entry.provider, (counts.get(entry.provider) ?? 0) + 1);
    return counts;
  }, [runtimeEntries, freeEntries, catalogEntries]);
  const chipProviders = MODEL_PROVIDERS.filter((provider) => provider !== "other" && (providerCounts.get(provider) ?? 0) > 0);
  const totalCount = runtimeEntries.length + freeEntries.length + catalogEntries.length;
  const busyId = select.isPending ? select.variables?.entry.id : null;

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

        {/* Everything under the title scrolls as one column. The thinking
            depth and the free-model tools panel used to sit above the list,
            outside its scroll area; with a free agent on a phone they took
            most of the sheet's height and left the models a sliver that could
            not scroll past the first rows. The search bar and maker chips
            stick to the top of the column so filtering is always in reach. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="model-picker-scroll">
        <ThinkingDepthControl agent={agent} className="px-4 pb-3" />
        {runsFreeChat ? <FreeToolsPanel agent={agent} imageOptions={freeImageOptions} /> : null}
        {runsFreeChat && isMoanModel(currentModel) ? <MoanKnowledgeCard /> : null}

        <div className="sticky top-0 z-10 space-y-2 bg-background px-4 pt-1 pb-2">
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

        <div className="border-t border-border px-2 pt-2 pb-4">
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
              <QueEngineStatus companyId={companyId} />
              <FreeUsageCard companyId={companyId} />
              {visibleFree.map((entry) => (
                <ModelRow
                  key={`free-${entry.id}`}
                  entry={entry}
                  current={runsFree && entry.id === currentModel}
                  locked={false}
                  busy={busyId === entry.id}
                  health={freeHealth.data?.[resolveFreeModel(entry.id).puterModel]}
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
          </section>}
          {(filter === "free" || (!catalog.isPending && !catalog.error)) && visibleGroups.length === 0 && visibleRuntime.length === 0 && visibleFree.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No models match “{query}”.</p>
          ) : null}

          <ByokKeysCard connected={connected} className="mx-1 mt-4" />
        </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
