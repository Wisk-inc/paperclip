import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, SquareTerminal } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import type { TranscriptEntry } from "@/adapters";
import { heartbeatsApi } from "@/api/heartbeats";
import { useLiveRunTranscripts } from "@/components/transcript/useLiveRunTranscripts";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Link } from "@/lib/router";
import { cn, relativeTime } from "@/lib/utils";

const OUTPUT_LINES = 40;

interface TerminalLine {
  key: string;
  kind: "command" | "output" | "error" | "note";
  text: string;
}

function commandOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return typeof input === "string" ? input : null;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return null;
}

function isShellTool(name: string, input: unknown): boolean {
  return /command|shell|bash|exec|terminal|run_cmd/i.test(name) || commandOf(input) !== null;
}

function clip(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  if (lines.length <= OUTPUT_LINES) return lines.join("\n");
  return [...lines.slice(0, OUTPUT_LINES), `… ${lines.length - OUTPUT_LINES} more lines`].join("\n");
}

/** The command a plain-process agent runs, from its settings (`command` plus `args`). */
export function processCommand(adapterConfig: Record<string, unknown> | null | undefined): string | null {
  const command = typeof adapterConfig?.command === "string" ? adapterConfig.command.trim() : "";
  if (!command) return null;
  const args = Array.isArray(adapterConfig?.args) ? adapterConfig.args.filter((arg): arg is string => typeof arg === "string") : [];
  return [command, ...args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

/**
 * The shell side of a run: each command the agent ran, then what it printed.
 * A run with no tool calls is a plain process, so its own output is the
 * terminal (after `rawCommand`, the command it was started with).
 */
export function terminalLines(entries: TranscriptEntry[], rawCommand?: string | null): TerminalLine[] {
  const structured = entries.some((entry) => entry.kind === "tool_call");
  const shellCalls = new Set<string>();
  const lines: TerminalLine[] = [];
  if (!structured && rawCommand) lines.push({ key: "raw", kind: "command", text: rawCommand });
  entries.forEach((entry, index) => {
    if (entry.kind === "tool_call" && isShellTool(entry.name, entry.input)) {
      if (entry.toolUseId) shellCalls.add(entry.toolUseId);
      lines.push({ key: `c${index}`, kind: "command", text: commandOf(entry.input) ?? entry.name });
    } else if (entry.kind === "tool_result" && shellCalls.has(entry.toolUseId) && entry.content.trim()) {
      lines.push({ key: `o${index}`, kind: entry.isError ? "error" : "output", text: clip(entry.content) });
    } else if (!structured && entry.kind === "stdout" && entry.text.trim()) {
      lines.push({ key: `s${index}`, kind: entry.text.startsWith("[paperclip]") ? "note" : "output", text: clip(entry.text) });
    } else if (entry.kind === "stderr" && entry.text.trim()) {
      lines.push({ key: `e${index}`, kind: "error", text: clip(entry.text) });
    } else if (entry.kind === "run_terminal") {
      lines.push({ key: `t${index}`, kind: "note", text: `run ${entry.runState}` });
    }
  });
  return lines;
}

/**
 * The agent's terminal: the commands it ran on the machine that hosts
 * Automa (your computer, a server, or this phone through Termux) and their
 * output, run by run. The full run page has the whole transcript.
 */
export function AgentTerminalSheet({ agent, open, onOpenChange }: { agent: Agent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const runs = useQuery({
    queryKey: ["agent-terminal-runs", agent.companyId, agent.id],
    queryFn: () => heartbeatsApi.list(agent.companyId, agent.id, 8),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = runs.data?.find((run) => run.id === selectedId) ?? runs.data?.[0] ?? null;
  const { transcriptByRun, isInitialHydrating } = useLiveRunTranscripts({
    runs: open && selected
      ? [{
          id: selected.id,
          status: selected.status,
          adapterType: agent.adapterType,
          hasStoredOutput: (selected.logBytes ?? 0) > 0,
          logBytes: selected.logBytes,
          lastOutputBytes: selected.lastOutputBytes,
        }]
      : [],
    companyId: agent.companyId,
  });
  const rawCommand = agent.adapterType === "process" ? processCommand(agent.adapterConfig) : null;
  const lines = useMemo(
    () => (selected ? terminalLines(transcriptByRun.get(selected.id) ?? [], rawCommand) : []),
    [selected, transcriptByRun, rawCommand],
  );
  const live = selected?.status === "running" || selected?.status === "queued";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-2xl md:-translate-x-1/2" data-testid="agent-terminal-sheet">
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
        <SheetHeader className="gap-1 px-4 pt-3 pb-2">
          <SheetTitle className="flex items-center gap-2 text-base">
            <SquareTerminal className="size-4" aria-hidden="true" />
            {agent.name}&apos;s terminal
          </SheetTitle>
          <SheetDescription className="text-xs">
            Commands {agent.name} ran on the machine that hosts Automa: your computer, a server, or this phone with Termux.
          </SheetDescription>
        </SheetHeader>

        {runs.data && runs.data.length > 0 ? (
          <div className="-mx-0 flex gap-2 overflow-x-auto px-4 pb-2" role="group" aria-label="Runs">
            {runs.data.map((run, index) => (
              <button
                key={run.id}
                type="button"
                aria-pressed={run.id === selected?.id}
                onClick={() => setSelectedId(run.id)}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
                  run.id === selected?.id ? "border-primary bg-accent font-medium" : "border-border bg-card hover:bg-accent/60",
                )}
              >
                <span
                  className={cn(
                    "size-2 rounded-full",
                    run.status === "running" || run.status === "queued" ? "bg-emerald-500 motion-safe:animate-pulse" : run.status === "failed" ? "bg-red-500" : "bg-muted-foreground",
                  )}
                  aria-hidden="true"
                />
                {index === 0 ? "Latest" : relativeTime(run.createdAt)}
              </button>
            ))}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          <div className="min-h-48 rounded-lg border border-border bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100" data-testid="agent-terminal">
            {runs.isPending || (selected && isInitialHydrating) ? (
              <p className="flex items-center gap-2 text-zinc-400"><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />Loading…</p>
            ) : !selected ? (
              <p className="text-zinc-400">No runs yet. When {agent.name} works on something, the commands it runs show up here.</p>
            ) : lines.length === 0 ? (
              <p className="text-zinc-400">{live ? `${agent.name} is working; no commands yet…` : "This run did not run any commands."}</p>
            ) : (
              lines.map((line) => (
                <pre
                  key={line.key}
                  className={cn(
                    "whitespace-pre-wrap break-words",
                    line.kind === "command" && "mt-2 font-semibold text-emerald-300 first:mt-0",
                    line.kind === "output" && "text-zinc-300",
                    line.kind === "error" && "text-red-300",
                    line.kind === "note" && "mt-2 text-zinc-500",
                  )}
                >
                  {line.kind === "command" ? `$ ${line.text}` : line.text}
                </pre>
              ))
            )}
            {live ? <span className="mt-1 inline-block h-3.5 w-2 bg-zinc-100 motion-safe:animate-pulse" aria-hidden="true" /> : null}
          </div>
          {selected ? (
            <Link
              to={`/agents/${agent.id}/runs/${selected.id}`}
              onClick={() => onOpenChange(false)}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary"
            >
              Open the full run
              <ExternalLink className="size-3" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
