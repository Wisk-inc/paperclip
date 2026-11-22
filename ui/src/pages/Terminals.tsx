import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleStop, Loader2, Play, SquareTerminal, Wrench } from "lucide-react";
import { freeModelOffline, TERMINAL_TOOLS, type FreeModelHealthMap, type TerminalSessionSummary, type TerminalToolId, type TerminalToolInfo } from "@paperclipai/shared";
import { freeModelsApi } from "@/api/free-models";
import { terminalsApi } from "@/api/terminals";
import { FreeModelCheck, freeModelHealthOf } from "@/components/FreeModelCheck";
import { TerminalView } from "@/components/terminals/TerminalView";
import { Mascot } from "@/components/mascot/Mascot";
import { isServerTooOld, PhoneServerOutdated, retryUnlessServerTooOld } from "@/components/device/PhoneServerOutdated";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useSearchParams } from "@/lib/router";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { modelDisplayName } from "@/lib/model-brand";
import { terminalModelsWithCatalog, useModelCatalog } from "@/lib/model-catalog";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/** The server's own rule for a model name passed to a tool's flag. */
export const TERMINAL_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

/** A model saved for a tool, while the tool still offers it (a release can drop one). */
export function offeredModel(tool: Pick<TerminalToolInfo, "models">, saved: string | undefined): string | undefined {
  return saved && tool.models?.includes(saved) ? saved : undefined;
}

/**
 * The model a tool opens with: the one chosen, else nothing (the tool's own
 * default), except where the picker names its default (the free models):
 * then that model, so what opens is what the picker said.
 */
export function launchModel(tool: Pick<TerminalToolInfo, "id" | "models">, saved: string | undefined): string | undefined {
  return offeredModel(tool, saved) ?? (tool.id === "freechat" ? tool.models?.[0] : undefined);
}

/** A programming language saved for a tool, while the tool still offers it. */
export function offeredLanguage(tool: Pick<TerminalToolInfo, "languages">, saved: string | undefined): string | undefined {
  return saved && tool.languages?.some((language) => language.id === saved) ? saved : undefined;
}

/**
 * The size a terminal will have, worked out from the window before the
 * terminal is on screen. A tool lays out its first lines for the size it is
 * started with: started at 80 columns on a phone that shows about 55, its
 * opening text breaks in the middle of words. The terminal view sets the exact
 * size once it is drawn; this is the terminal font's cell (12px JetBrains
 * Mono, line height 1.3) and the room the header and key bar take.
 */
export function terminalSizeGuess(width: number = window.innerWidth, height: number = window.innerHeight): { cols: number; rows: number } {
  const CELL_WIDTH = 7.2;
  const CELL_HEIGHT = 16;
  const SIDE_PADDING = 12;
  const HEADER_AND_KEYS = 120;
  const cols = Math.floor((width - SIDE_PADDING) / CELL_WIDTH);
  const rows = Math.floor((height - HEADER_AND_KEYS) / CELL_HEIGHT);
  return {
    cols: Number.isFinite(cols) ? Math.min(200, Math.max(40, cols)) : 80,
    rows: Number.isFinite(rows) ? Math.min(100, Math.max(12, rows)) : 24,
  };
}

/** What the language menu's first entry says: what the tool compiles to when no language is picked. */
export function defaultLanguageLabel(tool: Pick<TerminalToolInfo, "id">): string {
  // IMY keeps its own choice (`:target` in its console, or `imy init`), which starts as Python.
  if (tool.id === "imy") return "IMY's own language (Python at first)";
  return "The tool's own language";
}

/** The tools whose menus list Automa's free models. */
const FREE_MODEL_TOOLS: ReadonlySet<TerminalToolId> = new Set<TerminalToolId>(["freechat", "imy"]);

/**
 * A model's line in a tool's menu. A free model that did not answer when it
 * was last asked says so: Automa opens the tool with exactly the model picked,
 * so picking one that is offline only fails later.
 */
export function modelOptionLabel(toolId: TerminalToolId, modelId: string, health?: FreeModelHealthMap): string {
  const label = `${modelDisplayName(modelId)} · ${modelId}`;
  if (!FREE_MODEL_TOOLS.has(toolId) || !freeModelOffline(freeModelHealthOf(health, modelId))) return label;
  return `${label} · not answering now`;
}

/** What the model menu's first entry says: what opens when no model is picked. */
export function defaultModelLabel(tool: Pick<TerminalToolInfo, "id" | "models">): string {
  if (tool.id === "freechat") return `Default (${modelDisplayName(tool.models?.[0] ?? "")})`;
  // IMY keeps its own choice (`imy init`: a key of yours, or the free models, which it starts with).
  if (tool.id === "imy") return "IMY's own setting (free models at first)";
  return "The tool's own default model";
}

function ToolLogo({ tool, className }: { tool: TerminalToolInfo; className?: string }) {
  if (tool.brandDark) {
    return (
      <>
        <img src={tool.brand} alt="" className={cn(className, "dark:hidden")} />
        <img src={tool.brandDark} alt="" className={cn(className, "hidden dark:block")} />
      </>
    );
  }
  // The generic terminal glyph is drawn with the current text colour.
  if (tool.id === "shell") return <SquareTerminal className={cn(className, "text-foreground")} aria-hidden="true" />;
  return <img src={tool.brand} alt="" className={className} />;
}

/**
 * Terminals: open a real coding terminal (Claude Code, Codex, Gemini CLI,
 * OpenCode, Kimi) or a plain shell on the device Automa runs on, and use it
 * from here. On a phone the desktop-Linux agents run inside a Debian layer the
 * first use sets up; on a computer they run directly.
 */
export function Terminals() {
  const { selectedCompanyId: companyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const client = useQueryClient();
  const [open, setOpen] = useState<TerminalSessionSummary | null>(null);
  // The model each tool opens with, remembered per tool on this device. Above
  // any early return: the page first renders before an organization is chosen.
  const [models, setModels] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem("automa.terminals.models") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const chooseModel = (toolId: string, model: string) => {
    setModels((current) => {
      const next = { ...current, [toolId]: model };
      try { window.localStorage.setItem("automa.terminals.models", JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  };
  // The programming language a tool opens in (IMY compiles to it), remembered the same way.
  const [languages, setLanguages] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem("automa.terminals.languages") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const chooseLanguage = (toolId: string, language: string) => {
    setLanguages((current) => {
      const next = { ...current, [toolId]: language };
      try { window.localStorage.setItem("automa.terminals.languages", JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  };

  useEffect(() => {
    setBreadcrumbs([{ label: "Terminals" }]);
  }, [setBreadcrumbs]);

  const status = useQuery({
    queryKey: ["terminals", "status", companyId],
    queryFn: () => terminalsApi.status(companyId!),
    enabled: Boolean(companyId),
    retry: retryUnlessServerTooOld,
  });
  const sessions = useQuery({
    queryKey: ["terminals", "sessions", companyId],
    queryFn: () => terminalsApi.sessions(companyId!),
    enabled: Boolean(companyId),
    retry: retryUnlessServerTooOld,
    refetchInterval: (query) => (open || isServerTooOld(query.state.error) ? false : 4000),
  });

  const installed = useMemo(() => new Map((status.data?.tools ?? []).map((tool) => [tool.id, tool.installed])), [status.data]);
  // Tools this Automa ships a newer copy of than the one installed (IMY). The
  // update is offered once a visit: if it does not go through (no connection),
  // the next tap opens what is installed instead of asking again.
  const [updateTried, setUpdateTried] = useState<ReadonlySet<TerminalToolId>>(() => new Set());
  const updates = useMemo(
    () => new Set((status.data?.tools ?? []).filter((tool) => tool.installed && tool.update && !updateTried.has(tool.id)).map((tool) => tool.id)),
    [status.data, updateTried],
  );
  // Each tool's models with the newer ones of the catalog the server keeps in
  // front (Claude Code, Codex, Gemini CLI), so a model released after this
  // Automa can be picked too.
  const modelCatalog = useModelCatalog();
  const tools = useMemo(
    () => TERMINAL_TOOLS.map((tool) => (tool.models?.length
      ? { ...tool, models: terminalModelsWithCatalog(tool.id, tool.models, modelCatalog.data?.models).models }
      : tool)),
    [modelCatalog.data],
  );
  // Which free models answer, for the Free models and IMY menus (filled by the check below, and by every chat).
  const freeHealth = useQuery({
    queryKey: queryKeys.freeModels.health(),
    queryFn: () => freeModelsApi.health(),
    enabled: Boolean(companyId),
    retry: retryUnlessServerTooOld,
    staleTime: 30_000,
  });
  const freeListed = useMemo(
    () => [...new Set(tools.filter((tool) => FREE_MODEL_TOOLS.has(tool.id)).flatMap((tool) => tool.models ?? []))],
    [tools],
  );
  // What is still running. The server keeps an ended terminal for a minute so a
  // reconnect can read its last lines; it used to stay listed under "Running now".
  const running = useMemo(
    () => (sessions.data?.sessions ?? []).filter((session) => session.status !== "exited"),
    [sessions.data],
  );
  const phone = status.data?.kind === "phone";
  const linuxReady = status.data?.linuxReady ?? true;
  // Servers before 1.9.6 don't report it: assume the relay is there.
  const relayReady = status.data?.relayReady ?? true;

  const start = useMutation({
    mutationFn: (input: { toolId: TerminalToolId; mode: "run" | "install" | "setup" | "shell"; agentId?: string; model?: string; language?: string }) =>
      terminalsApi.start(companyId!, { ...input, ...terminalSizeGuess() }),
    onSuccess: ({ session }) => {
      haptic("tick");
      setOpen(session);
      void client.invalidateQueries({ queryKey: ["terminals", "sessions", companyId] });
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn't open the terminal", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  // What is installed changes inside a terminal (Install, Set up now): look again on the way out.
  const refreshStatus = () => void client.invalidateQueries({ queryKey: ["terminals", "status", companyId] });
  const stop = useMutation({
    mutationFn: (id: string) => terminalsApi.stop(companyId!, id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["terminals", "sessions", companyId] });
      refreshStatus();
    },
  });
  // A tool installing in a terminal left in the background: when its program
  // ends, look again at what is installed, so its tile says Ready without a
  // visit to that terminal.
  const runningIds = running.map((session) => session.id).join(" ");
  const lastRunningIds = useRef(runningIds);
  useEffect(() => {
    const before = lastRunningIds.current ? lastRunningIds.current.split(" ") : [];
    lastRunningIds.current = runningIds;
    const now = new Set(runningIds ? runningIds.split(" ") : []);
    if (before.some((id) => !now.has(id))) refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningIds]);

  // A deep link from an agent's settings ("Open Claude Code with Ada's model") auto-opens the tool.
  const [params, setParams] = useSearchParams();
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !status.data) return;
    const toolParam = params.get("tool");
    if (!toolParam || !TERMINAL_TOOLS.some((t) => t.id === toolParam)) return;
    autoStarted.current = true;
    const agentParam = params.get("agent") ?? undefined;
    const modelParam = params.get("model") ?? "";
    const toolId = toolParam as TerminalToolId;
    const isInstalled = toolId === "shell" || installed.get(toolId);
    const mode = toolId === "shell" ? "shell" : isInstalled ? "run" : "install";
    // The agent's own model, so the terminal runs what the agent runs.
    const model = mode === "run" && TERMINAL_MODEL_PATTERN.test(modelParam) ? modelParam : undefined;
    start.mutate({ toolId, mode, agentId: agentParam, ...(model ? { model } : {}) });
    const next = new URLSearchParams(params);
    next.delete("tool");
    next.delete("agent");
    next.delete("model");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data]);

  if (!companyId) return null;

  const openTool = (tool: TerminalToolInfo) => {
    if (tool.id === "shell") return start.mutate({ toolId: "shell", mode: "shell" });
    const model = launchModel(tool, models[tool.id]);
    const language = offeredLanguage(tool, languages[tool.id]);
    if (updates.has(tool.id)) {
      setUpdateTried((tried) => new Set(tried).add(tool.id));
      return start.mutate({ toolId: tool.id, mode: "install" });
    }
    if (installed.get(tool.id)) {
      return start.mutate({ toolId: tool.id, mode: "run", ...(model ? { model } : {}), ...(language ? { language } : {}) });
    }
    return start.mutate({ toolId: tool.id, mode: "install" });
  };

  // Full-screen terminal.
  if (open) {
    return (
      <div className="studio-ide-immersive fixed inset-0 z-40 flex flex-col bg-background pt-(--sz-safe-top) pb-(--sz-safe-bottom)">
        <div className="flex items-center gap-2 border-b border-border bg-linear-to-r from-primary/10 to-transparent px-2 py-1.5">
          <Button variant="ghost" size="icon-sm" aria-label="Back to terminals" onClick={() => { haptic("tick"); setOpen(null); refreshStatus(); }}>
            <ArrowLeft />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{open.title}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              stop.mutate(open.id);
            }}
            data-testid="terminal-stop"
          >
            <CircleStop /> Stop
          </Button>
        </div>
        <TerminalView companyId={companyId} sessionId={open.id} className="min-h-0 flex-1" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5" data-testid="terminals-page">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <SquareTerminal className="size-5 text-muted-foreground" aria-hidden="true" />
          Terminals
        </h1>
        <p className="text-sm text-muted-foreground">
          Open a real coding terminal on {phone ? "this phone" : "this computer"} — Claude Code, Codex and more — and use it right here.
          {phone ? " The first time, Automa sets up a small Linux layer for the ones that need it." : ""}
        </p>
      </header>

      {status.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Checking what's installed…</p>
      ) : status.isError && isServerTooOld(status.error) ? (
        <PhoneServerOutdated feature="Terminals" onRetry={() => void status.refetch()} />
      ) : status.isError ? (
        <div className="flex items-center gap-4 rounded-xl border border-dashed border-border p-4">
          <Mascot pose="confused" size="sm" />
          <p className="text-sm text-muted-foreground">
            Terminals run on the device Automa runs on. They&apos;re available when you run Automa for yourself (on this phone, or your own
            computer), not on a shared server.
          </p>
        </div>
      ) : (
        <>
          {!relayReady ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4" role="alert" data-testid="terminals-relay-missing">
              <div className="flex items-center gap-2">
                <Wrench className="size-4 text-muted-foreground" aria-hidden="true" />
                <h2 className="text-sm font-semibold">Terminals need Python</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                {phone ? (
                  <>Every terminal runs through a small Python program. In Termux, run <code>pkg install python</code>, then check again.</>
                ) : (
                  <>Every terminal runs through a small Python program. Install Python 3 on this computer, then check again.</>
                )}
              </p>
              <div>
                <Button size="sm" variant="outline" onClick={() => void status.refetch()} disabled={status.isFetching}>
                  {status.isFetching ? <Loader2 className="animate-spin" /> : null} Check again
                </Button>
              </div>
            </div>
          ) : null}

          {phone && !linuxReady && relayReady ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4" data-testid="terminals-setup">
              <div className="flex items-center gap-2">
                <Wrench className="size-4 text-muted-foreground" aria-hidden="true" />
                <h2 className="text-sm font-semibold">Set up the Linux layer</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Claude Code and Codex are built for desktop Linux, so Automa runs them in a small Debian layer on this phone. Setting it up
                downloads a few hundred MB, once.
              </p>
              <div>
                <Button size="sm" onClick={() => start.mutate({ toolId: "claude", mode: "setup" })} disabled={start.isPending} data-testid="terminals-setup-start">
                  {start.isPending ? <Loader2 className="animate-spin" /> : <Play />} Set up now
                </Button>
              </div>
            </div>
          ) : null}

          {running.length > 0 ? (
            <section aria-label="Running terminals" className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">Running now</h2>
              <ul className="flex flex-col gap-2">
                {running.map((session) => (
                  <li key={session.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-3" data-testid="terminal-running">
                    <SquareTerminal className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{session.title}</span>
                    <Button variant="ghost" size="sm" onClick={() => { haptic("tick"); setOpen(session); }}>Open</Button>
                    <Button variant="ghost" size="sm" onClick={() => stop.mutate(session.id)}>Stop</Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <FreeModelCheck models={freeListed} />

          <section aria-label="Tools" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {tools.map((tool) => {
              const isInstalled = tool.id === "shell" || installed.get(tool.id);
              return (
                <button
                  key={tool.id}
                  type="button"
                  disabled={start.isPending || !relayReady}
                  onClick={() => { haptic("tick"); openTool(tool); }}
                  className="flex items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent/60 disabled:opacity-60"
                  data-testid="terminal-tool"
                  data-tool={tool.id}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <ToolLogo tool={tool} className="size-6" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{tool.label}</span>
                      {tool.id !== "shell" ? (
                        <span className={cn("rounded-full px-2 py-0.5 text-xs", isInstalled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                          {updates.has(tool.id) ? "Tap to update" : isInstalled ? "Ready" : "Tap to install"}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{tool.blurb}</span>
                    {tool.models?.length ? (
                      <select
                        aria-label={`Model for ${tool.label}`}
                        value={offeredModel(tool, models[tool.id]) ?? ""}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => { event.stopPropagation(); chooseModel(tool.id, event.target.value); }}
                        className="mt-2 h-8 w-full max-w-xs rounded-md border border-border bg-background px-2 text-xs text-foreground"
                        data-testid="terminal-model"
                      >
                        <option value="">{defaultModelLabel(tool)}</option>
                        {tool.models.map((id) => <option key={id} value={id}>{modelOptionLabel(tool.id, id, freeHealth.data)}</option>)}
                      </select>
                    ) : null}
                    {tool.languages?.length ? (
                      <select
                        aria-label={`Language for ${tool.label}`}
                        value={offeredLanguage(tool, languages[tool.id]) ?? ""}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => { event.stopPropagation(); chooseLanguage(tool.id, event.target.value); }}
                        className="mt-2 h-8 w-full max-w-xs rounded-md border border-border bg-background px-2 text-xs text-foreground"
                        data-testid="terminal-language"
                      >
                        <option value="">{defaultLanguageLabel(tool)}</option>
                        {/* A language's name is the same in every human language: "Go" and "Swift" are not words to translate. */}
                        {tool.languages.map((language) => (
                          <option key={language.id} value={language.id} translate="no">{language.name}</option>
                        ))}
                      </select>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}
