import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { Eraser, LoaderCircle, Send, SquareTerminal } from "lucide-react";
import type { StudioConsoleLine, StudioRunState } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SHOWN_LINES, useStudioConsoleLines, type StudioConsoleStore } from "./console-store";

interface StudioConsoleProps {
  /** The project's live console output (only this panel redraws when it changes). */
  store: StudioConsoleStore;
  run: StudioRunState | null;
  onClear?: () => void;
  /** Types a line into the running program (its standard input). */
  onInput?: (text: string) => Promise<void> | void;
  /** Runs a shell command in the project folder (install packages, git, tests). */
  onExec?: (command: string) => Promise<void> | void;
}

const LINE_TONE: Record<StudioConsoleLine["stream"], string> = {
  stdout: "text-studio-console-foreground",
  stderr: "text-studio-console-error",
  system: "text-studio-console-system",
  command: "text-studio-console-input",
};

/** Lines are drawn in blocks by sequence number, so new output redraws only the newest block. */
const CHUNK_LINES = 50;

function chunkLines(lines: StudioConsoleLine[]) {
  const chunks: Array<{ id: number; lines: StudioConsoleLine[] }> = [];
  for (const line of lines) {
    const id = Math.floor(line.seq / CHUNK_LINES);
    const last = chunks.at(-1);
    if (last && last.id === id) last.lines.push(line);
    else chunks.push({ id, lines: [line] });
  }
  return chunks;
}

const ConsoleChunk = memo(
  function ConsoleChunk({ lines }: { lines: StudioConsoleLine[] }) {
    // Consecutive lines of the same kind are one text block: far fewer
    // elements for the phone to lay out than one per line.
    const runs: Array<{ stream: StudioConsoleLine["stream"]; seq: number; text: string }> = [];
    for (const line of lines) {
      const text = line.stream === "command" ? `$ ${line.text}` : line.text;
      const last = runs.at(-1);
      if (last && last.stream === line.stream) last.text += `\n${text}`;
      else runs.push({ stream: line.stream, seq: line.seq, text });
    }
    return (
      <div data-console-chunk="">
        {runs.map((run) => (
          <div key={run.seq} className={cn("whitespace-pre-wrap break-words", LINE_TONE[run.stream])} data-console-run="">
            {run.text}
          </div>
        ))}
      </div>
    );
  },
  // Same first and last line: nothing in this block changed.
  (before, after) =>
    before.lines.length === after.lines.length &&
    before.lines[0]?.seq === after.lines[0]?.seq &&
    before.lines.at(-1)?.seq === after.lines.at(-1)?.seq,
);

/**
 * What the app printed, live: its output, its errors (red), Automa's notes,
 * and the commands that ran. While the app runs, the box types into it;
 * otherwise it runs a shell command in the project folder.
 */
export function StudioConsole({ store, run, onClear, onInput, onExec }: StudioConsoleProps) {
  const allLines = useStudioConsoleLines(store);
  // Only the newest lines are drawn; a long-running program can print thousands.
  const lines = allLines.length > SHOWN_LINES ? allLines.slice(-SHOWN_LINES) : allLines;
  const hidden = allLines.length - lines.length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const running = run?.status === "running" || run?.status === "starting";
  const mode: "input" | "exec" | null = running && onInput ? "input" : onExec ? "exec" : null;

  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [lines]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text;
    if (!mode || (mode === "exec" && !value.trim())) return;
    setBusy(true);
    try {
      if (mode === "input") await onInput?.(value);
      else await onExec?.(value.trim());
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-studio-console text-studio-console-foreground">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-xs">
        <SquareTerminal className="size-3.5" />
        <span className="font-medium">Console</span>
        {run ? (
          <span className="truncate font-mono opacity-70">
            {run.status === "running" ? "running" : run.status === "starting" ? "starting…" : run.status}
            {run.exitCode !== null && run.status !== "running" ? ` · exit ${run.exitCode}` : ""}
          </span>
        ) : null}
        {onClear ? (
          <Button variant="ghost" size="icon-xs" className="ml-auto pointer-coarse:size-10 text-studio-console-foreground hover:bg-studio-console-foreground/10 hover:text-studio-console-foreground" aria-label="Clear console" onClick={onClear}>
            <Eraser />
          </Button>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-(length:--text-compact) leading-relaxed"
        role="log"
        aria-live="polite"
        aria-label="Console output"
        data-testid="studio-console"
      >
        {hidden > 0 ? (
          <p className="pb-1 opacity-60" data-testid="studio-console-trimmed">
            {hidden.toLocaleString()} earlier {hidden === 1 ? "line" : "lines"} not shown
          </p>
        ) : null}
        {lines.length === 0 ? (
          <p className="opacity-60">Nothing yet. Tap Run, and what your app prints shows up here.</p>
        ) : (
          chunkLines(lines).map((chunk) => <ConsoleChunk key={chunk.id} lines={chunk.lines} />)
        )}
      </div>
      {mode ? (
        <form onSubmit={submit} className="flex items-center gap-2 border-t border-border/40 px-2 py-1.5">
          <span className="font-mono text-xs text-studio-console-input">{mode === "input" ? ">" : "$"}</span>
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={mode === "input" ? "Type into your running app" : "Run a command, e.g. npm install express"}
            aria-label={mode === "input" ? "Input for the running app" : "Shell command"}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-8 border-transparent bg-transparent font-mono text-sm text-studio-console-foreground shadow-none placeholder:text-studio-console-foreground/70 focus-visible:ring-0"
          />
          <Button type="submit" size="icon-sm" variant="ghost" disabled={busy} aria-label={mode === "input" ? "Send input" : "Run command"} className="text-studio-console-foreground hover:bg-studio-console-foreground/10 hover:text-studio-console-foreground">
            {busy ? <LoaderCircle className="animate-spin" /> : <Send />}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
