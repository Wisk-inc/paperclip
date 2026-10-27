import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleStop, Loader2, Play, SquareTerminal, Wrench } from "lucide-react";
import { TERMINAL_TOOLS, type TerminalSessionSummary, type TerminalToolId, type TerminalToolInfo } from "@paperclipai/shared";
import { terminalsApi } from "@/api/terminals";
import { TerminalView } from "@/components/terminals/TerminalView";
import { Mascot } from "@/components/mascot/Mascot";
import { isServerTooOld, PhoneServerOutdated } from "@/components/device/PhoneServerOutdated";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useSearchParams } from "@/lib/router";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { modelDisplayName } from "@/lib/model-brand";
import { cn } from "@/lib/utils";

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

  useEffect(() => {
    setBreadcrumbs([{ label: "Terminals" }]);
  }, [setBreadcrumbs]);

  const status = useQuery({
    queryKey: ["terminals", "status", companyId],
    queryFn: () => terminalsApi.status(companyId!),
    enabled: Boolean(companyId),
  });
  const sessions = useQuery({
    queryKey: ["terminals", "sessions", companyId],
    queryFn: () => terminalsApi.sessions(companyId!),
    enabled: Boolean(companyId),
    refetchInterval: open ? false : 4000,
  });

  const installed = useMemo(() => new Map((status.data?.tools ?? []).map((tool) => [tool.id, tool.installed])), [status.data]);
  const running = sessions.data?.sessions ?? [];
  const phone = status.data?.kind === "phone";
  const linuxReady = status.data?.linuxReady ?? true;

  const start = useMutation({
    mutationFn: (input: { toolId: TerminalToolId; mode: "run" | "install" | "setup" | "shell"; agentId?: string; model?: string }) =>
      terminalsApi.start(companyId!, { ...input, cols: 80, rows: 24 }),
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

  const stop = useMutation({
    mutationFn: (id: string) => terminalsApi.stop(companyId!, id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["terminals", "sessions", companyId] }),
  });

  // A deep link from an agent ("Open a terminal as this agent") auto-opens the tool.
  const [params, setParams] = useSearchParams();
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !status.data) return;
    const toolParam = params.get("tool");
    if (!toolParam || !TERMINAL_TOOLS.some((t) => t.id === toolParam)) return;
    autoStarted.current = true;
    const agentParam = params.get("agent") ?? undefined;
    const toolId = toolParam as TerminalToolId;
    const isInstalled = toolId === "shell" || installed.get(toolId);
    start.mutate({ toolId, mode: toolId === "shell" ? "shell" : isInstalled ? "run" : "install", agentId: agentParam });
    const next = new URLSearchParams(params);
    next.delete("tool");
    next.delete("agent");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data]);

  if (!companyId) return null;

  // The model each tool opens with, remembered per tool on this device.
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
  const openTool = (tool: TerminalToolInfo) => {
    if (tool.id === "shell") return start.mutate({ toolId: "shell", mode: "shell" });
    const model = models[tool.id];
    if (installed.get(tool.id)) return start.mutate({ toolId: tool.id, mode: "run", ...(model ? { model } : {}) });
    return start.mutate({ toolId: tool.id, mode: "install" });
  };

  // Full-screen terminal.
  if (open) {
    return (
      <div className="studio-ide-immersive fixed inset-0 z-40 flex flex-col bg-background pt-(--sz-safe-top) pb-(--sz-safe-bottom)">
        <div className="flex items-center gap-2 border-b border-border bg-linear-to-r from-primary/10 to-transparent px-2 py-1.5">
          <Button variant="ghost" size="icon-sm" aria-label="Back to terminals" onClick={() => { haptic("tick"); setOpen(null); }}>
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
          {phone && !linuxReady ? (
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

          <section aria-label="Tools" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TERMINAL_TOOLS.map((tool) => {
              const isInstalled = tool.id === "shell" || installed.get(tool.id);
              return (
                <button
                  key={tool.id}
                  type="button"
                  disabled={start.isPending}
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
                          {isInstalled ? "Ready" : "Tap to install"}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{tool.blurb}</span>
                    {tool.models?.length ? (
                      <select
                        aria-label={`Model for ${tool.label}`}
                        value={models[tool.id] ?? ""}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => { event.stopPropagation(); chooseModel(tool.id, event.target.value); }}
                        className="mt-2 h-8 w-full max-w-xs rounded-md border border-border bg-background px-2 text-xs text-foreground"
                        data-testid="terminal-model"
                      >
                        <option value="">{tool.id === "freechat" ? `Default (${modelDisplayName(tool.models[0]!)})` : "The tool's own default model"}</option>
                        {tool.models.map((id) => <option key={id} value={id}>{modelDisplayName(id)} · {id}</option>)}
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
