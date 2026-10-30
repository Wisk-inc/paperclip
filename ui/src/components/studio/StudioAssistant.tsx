import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brain, Check, ChevronRight, CircleAlert, CircleStop, Globe, ImagePlus, KeyRound, LoaderCircle, MessageSquare, Paperclip, Send, Sparkles, Trash2, Undo2, Users, X } from "lucide-react";
import {
  STUDIO_AI_PROVIDERS,
  STUDIO_AI_PROVIDER_INFO,
  STUDIO_ASSISTANT_IMAGE_TYPES,
  STUDIO_ASSISTANT_MAX_ATTACHMENTS,
  STUDIO_ASSISTANT_MAX_IMAGE_BYTES,
  STUDIO_ASSISTANT_MAX_TEXT_BYTES,
  STUDIO_MAX_TEAMMATES,
  STUDIO_THINKING_LEVELS,
  type StudioAiKeyStatus,
  type StudioAiProvider,
  type StudioAssistantAttachmentInput,
  type StudioAssistantStep,
  type StudioAssistantTurn,
  type StudioTeamAgent,
  type StudioTeamMessage,
  type StudioTeammate,
  type StudioThinkingLevel,
} from "@paperclipai/shared";
import { formatSpend, formatTokens, modelTotals, turnWorkers, type TurnWorker } from "./studio-usage";
import { useNarrowScreen } from "@/hooks/useNarrowScreen";
import { useUndoableAction } from "@/hooks/useUndoableAction";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ModelLogo } from "@/components/ModelLogo";
import { MarkdownBody } from "@/components/MarkdownBody";
import { settleStreamingMarkdown } from "@/lib/streaming-markdown";
import { StudioModelSheet } from "./StudioModelSheet";
import { StudioThinkingControl, effectiveStudioThinking } from "./StudioThinkingControl";
import { modelDisplayName } from "@/lib/model-brand";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { Mascot } from "../mascot/Mascot";
import { ProgressBar } from "@/components/ui/progress-bar";

/** Claude models where Anthropic retries a declined request on another model. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

const SUGGESTIONS = [
  "Build a to-do app that saves to a database",
  "Explain how this project works",
  "Run it and fix any errors in the console",
  "Add a dark mode and make it look great on phones",
];

const TOOL_LABEL: Record<string, string> = {
  ask_teammate: "Asked a teammate",
  run_team: "Ran the team",
  message_team: "Messaged the team",
  undo_edit: "Undid a change",
  search_files: "Searched the files",
  web_search: "Searched the web",
  web_fetch: "Read a web page",
  list_files: "Looked at the files",
  read_file: "Read",
  write_file: "Wrote",
  edit_file: "Edited",
  delete_path: "Deleted",
  run_command: "Ran",
  read_console: "Read the console",
  start_app: "Started the app",
  stop_app: "Stopped the app",
};

interface StudioAssistantProps {
  turns: StudioAssistantTurn[];
  running: boolean;
  keys: StudioAiKeyStatus[];
  onSaveKey: (provider: StudioAiProvider, apiKey: string, baseUrl: string | null) => Promise<void>;
  onRemoveKey: (provider: StudioAiProvider) => Promise<void>;
  onSend: (
    message: string,
    provider: StudioAiProvider,
    model: string,
    attachments?: StudioAssistantAttachmentInput[],
    thinking?: StudioThinkingLevel,
    team?: StudioTeammate[],
  ) => Promise<void>;
  onStop: () => Promise<void>;
  onClear: () => Promise<void>;
  /** Goes back to the checkpoint saved before a message. */
  onUndo?: (checkpointId: string) => Promise<void>;
  /** Reverses one file change the assistant made (the Undo beside a step). */
  onUndoEdit?: (editId: string) => Promise<void>;
  /** Remembers the provider, model and thinking level per organization. */
  storageKey: string;
  /** A first message to send once a key is ready (from "describe your app"). */
  initialPrompt?: string | null;
  onInitialPromptUsed?: () => void;
  /** For the OpenRouter catalog in the model sheet. */
  companyId?: string;
  /** The app answers in the preview: a reply that started it offers to open the page. */
  previewReady?: boolean;
  onShowPreview?: () => void;
}

interface AiChoice {
  provider: StudioAiProvider;
  model: string;
  thinking?: StudioThinkingLevel;
  /** Models the lead hands tasks to. */
  team?: StudioTeammate[];
}

function readTeam(value: unknown): StudioTeammate[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is { provider: string; model: string } => Boolean(entry) && typeof entry === "object" && typeof (entry as { provider?: unknown }).provider === "string" && typeof (entry as { model?: unknown }).model === "string")
    .filter((entry) => (STUDIO_AI_PROVIDERS as readonly string[]).includes(entry.provider) && entry.model.trim())
    .slice(0, STUDIO_MAX_TEAMMATES)
    .map((entry) => ({ provider: entry.provider as StudioAiProvider, model: entry.model.trim() }));
}

function readChoice(storageKey: string): AiChoice {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { provider?: string; model?: string; thinking?: string; team?: unknown };
      if (parsed.provider && (STUDIO_AI_PROVIDERS as readonly string[]).includes(parsed.provider)) {
        const thinking = (STUDIO_THINKING_LEVELS as readonly string[]).includes(parsed.thinking ?? "")
          ? (parsed.thinking as StudioThinkingLevel)
          : undefined;
        const team = readTeam(parsed.team);
        return {
          provider: parsed.provider as StudioAiProvider,
          model: parsed.model || STUDIO_AI_PROVIDER_INFO[parsed.provider as StudioAiProvider].defaultModel,
          ...(thinking ? { thinking } : {}),
          ...(team.length ? { team } : {}),
        };
      }
    }
  } catch {
    // storage unavailable
  }
  // The free models need no key, so a new project can start right away.
  return { provider: "free", model: STUDIO_AI_PROVIDER_INFO.free.defaultModel };
}

type StepGroup = { kind: "say"; text: string } | { kind: "tools"; steps: StudioAssistantStep[] };

/** A file picked for the next message, read once so sending never waits on disk. */
interface PendingAttachment {
  id: string;
  file: File;
  input: StudioAssistantAttachmentInput;
  /** Images get a thumbnail; text files a paperclip. */
  previewUrl: string | null;
}

function isImage(file: File) {
  return (STUDIO_ASSISTANT_IMAGE_TYPES as readonly string[]).includes(file.type);
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file"));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Reads a picked file into what the assistant takes, or explains why it can't. */
async function toAttachment(file: File): Promise<PendingAttachment> {
  const id = `${file.name}:${file.size}:${file.lastModified}`;
  if (isImage(file)) {
    if (file.size > STUDIO_ASSISTANT_MAX_IMAGE_BYTES) throw new Error(`${file.name} is over ${Math.round(STUDIO_ASSISTANT_MAX_IMAGE_BYTES / 1024 / 1024)} MB. Send a smaller image.`);
    return { id, file, previewUrl: URL.createObjectURL(file), input: { name: file.name, type: file.type, encoding: "base64", data: await readAsBase64(file) } };
  }
  if (file.size > STUDIO_ASSISTANT_MAX_TEXT_BYTES) throw new Error(`${file.name} is over ${Math.round(STUDIO_ASSISTANT_MAX_TEXT_BYTES / 1024)} KB. Add it to the project instead and ask about it.`);
  const text = await file.text();
  if (text.includes("\u0000")) throw new Error(`${file.name} is not a text file or an image.`);
  return { id, file, previewUrl: null, input: { name: file.name, type: file.type || "text/plain", encoding: "text", data: text } };
}

/** What the assistant said, and runs of tool steps between its messages. */
function groupSteps(steps: StudioAssistantStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const step of steps) {
    if (step.tool === "say") {
      groups.push({ kind: "say", text: step.summary });
      continue;
    }
    const last = groups.at(-1);
    if (last?.kind === "tools") last.steps.push(step);
    else groups.push({ kind: "tools", steps: [step] });
  }
  return groups;
}

function StepRow({ step, onUndoEdit, disabled }: { step: StudioAssistantStep; onUndoEdit?: (editId: string) => Promise<void>; disabled?: boolean }) {
  const summary = step.summary || TOOL_LABEL[step.tool] || step.tool;
  const [undoing, setUndoing] = useState(false);
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", step.ok ? "text-muted-foreground" : "text-destructive")}>
        {step.ok ? <Check className="size-3 shrink-0" /> : <CircleAlert className="size-3 shrink-0" />}
        <span className={cn("min-w-0 flex-1 truncate font-mono", step.undone && "line-through")}>{summary}</span>
        {step.editId && step.undone ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-(length:--text-micro)" data-testid="studio-step-undone">Undone</span>
        ) : step.editId && onUndoEdit ? (
          <button
            type="button"
            disabled={disabled || undoing}
            onClick={() => {
              setUndoing(true);
              void onUndoEdit(step.editId!).finally(() => setUndoing(false));
            }}
            className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label={`Undo: ${summary}`}
            data-testid="studio-step-undo"
          >
            {undoing ? <LoaderCircle className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
            Undo
          </button>
        ) : null}
      </span>
      {step.detail ? <pre className="ml-4 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted px-2 py-1 font-mono text-(length:--text-micro) text-muted-foreground">{step.detail}</pre> : null}
    </li>
  );
}

/** A thought the model had before acting; tap to read all of it. */
function ThoughtRow({ step }: { step: StudioAssistantStep }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-8 min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        data-testid="studio-thought"
      >
        <Brain className="size-3.5 shrink-0" aria-hidden="true" />
        <span className={cn("min-w-0 flex-1", open ? "" : "truncate")}>{open ? "Thought" : step.summary}</span>
        <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-(--motion-duration-fast)", open && "rotate-90")} aria-hidden="true" />
      </button>
      {open && step.detail ? (
        <div className="ml-5 min-w-0 border-l-2 border-border pl-2 text-xs text-muted-foreground">
          <MarkdownBody softBreaks>{step.detail}</MarkdownBody>
        </div>
      ) : null}
    </li>
  );
}

/** One teammate's card: role, status, what it is doing, and (tap) its task, steps and report. */
/** A teammate's step as its own card shows it: without the "Name (role) · " the lead's log puts first. */
function withoutAgentLabel(step: StudioAssistantStep, agent: StudioTeamAgent): StudioAssistantStep {
  const cut = step.summary.indexOf(" · ");
  return cut > 0 && step.summary.startsWith(agent.name) ? { ...step, summary: step.summary.slice(cut + 3) } : step;
}

function TeamAgentCard({ agent, steps, onUndoEdit, disabled }: { agent: StudioTeamAgent; steps: StudioAssistantStep[]; onUndoEdit?: (editId: string) => Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const toolSteps = steps.filter((step) => step.tool !== "say").map((step) => withoutAgentLabel(step, agent));
  const said = steps.filter((step) => step.tool === "say").map((step) => step.summary);
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-2.5 py-2" data-testid="studio-team-agent" data-status={agent.status}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex min-w-0 items-center gap-2 text-left">
        <ModelLogo modelId={agent.model} size="xs" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">{agent.name}{agent.role ? <span className="font-normal text-muted-foreground"> · {agent.role}</span> : null}</span>
          <span className="block truncate text-(length:--text-micro) text-muted-foreground tabular-nums">
            {agent.status === "working"
              ? `${agent.activity ? `${agent.activity}…` : "Working…"} · ${agent.steps} step${agent.steps === 1 ? "" : "s"}`
              : agent.status === "done"
                ? `Done · ${agent.steps} step${agent.steps === 1 ? "" : "s"}`
                : `Could not finish${agent.error ? `: ${agent.error}` : ""}`}
            {agent.usage ? ` · ${formatTokens(agent.usage.inputTokens + agent.usage.outputTokens)} tokens` : ""}
          </span>
        </span>
        {agent.status === "working" ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-(--status-agent-running)" aria-label="Working" />
        ) : agent.status === "done" ? (
          <Check className="size-3.5 shrink-0 text-muted-foreground" aria-label="Done" />
        ) : (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-label="Failed" />
        )}
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-(--motion-duration-fast)", open && "rotate-90")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-2 text-xs">
          <div className="min-w-0 text-muted-foreground">
            <span className="font-medium text-foreground">Task: </span>
            <span className="whitespace-pre-wrap break-words">{agent.task}</span>
          </div>
          {toolSteps.length ? (
            <ul className="flex flex-col gap-1 border-l-2 border-border pl-2">
              {toolSteps.map((step, index) =>
                step.tool === "think" ? <ThoughtRow key={index} step={step} /> : <StepRow key={index} step={step} onUndoEdit={onUndoEdit} disabled={disabled} />,
              )}
            </ul>
          ) : null}
          {agent.report || said.length ? (
            <div className="min-w-0 break-words">
              <MarkdownBody softBreaks>{agent.report ?? said.join("\n\n")}</MarkdownBody>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Every model on this reply, as logos that boot up when they join: the lead first, then each teammate. */
function TeamRoster({ workers }: { workers: TurnWorker[] }) {
  return (
    <ul className="flex flex-wrap gap-3" aria-label="Models on this job" data-testid="studio-team-roster">
      {workers.map((worker, index) => {
        const tokens = worker.usage ? worker.usage.inputTokens + worker.usage.outputTokens : 0;
        const statusLabel = worker.status === "working" ? "working" : worker.status === "done" ? "done" : "could not finish";
        return (
          <li
            key={worker.id}
            className="studio-boot-in flex w-20 flex-col items-center gap-0.5 text-center"
            style={{ animationDelay: `${index * 90}ms` }}
            title={`${worker.name}${worker.role ? ` · ${worker.role}` : ""}: ${statusLabel}`}
            data-status={worker.status}
          >
            <span
              className={cn(
                "relative rounded-lg p-0.5 ring-2",
                worker.status === "working" ? "ring-(--status-agent-running)" : worker.status === "failed" ? "ring-destructive" : "ring-border",
              )}
            >
              <ModelLogo modelId={worker.model} size="md" />
              <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-border bg-background">
                {worker.status === "working" ? (
                  <LoaderCircle className="size-3 animate-spin text-(--status-agent-running)" aria-hidden="true" />
                ) : worker.status === "done" ? (
                  <Check className="size-3 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <CircleAlert className="size-3 text-destructive" aria-hidden="true" />
                )}
              </span>
            </span>
            <span className="w-full truncate text-(length:--text-micro) font-medium text-foreground">{worker.name}</span>
            <span className="w-full truncate text-(length:--text-micro) text-muted-foreground tabular-nums">
              {worker.lead ? "Lead" : (worker.role?.split(/[:,—-]/)[0]?.trim() || "Teammate")}
              {tokens ? ` · ${formatTokens(tokens)}` : ""}
            </span>
            <span className="sr-only">{statusLabel}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** One line of the team chat; long tasks and reports open on a tap. */
function TeamChatLine({ message }: { message: StudioTeamMessage }) {
  const long = message.text.length > 280;
  const [open, setOpen] = useState(false);
  const verb = message.kind === "task" ? "to" : message.kind === "report" ? "reported to" : "→";
  return (
    <li className="flex min-w-0 gap-2" data-kind={message.kind}>
      <ModelLogo modelId={message.fromModel} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1 text-xs">
          <span className="font-medium text-foreground">{message.fromName}</span>
          <span className="text-muted-foreground">{verb}</span>
          <span className="font-medium text-foreground">{message.toName ?? "everyone"}</span>
          {message.kind !== "message" ? (
            <span className="rounded-full bg-muted px-1.5 text-(length:--text-micro) text-muted-foreground">{message.kind === "task" ? "Task" : "Report"}</span>
          ) : null}
        </div>
        <div
          className={cn(
            "mt-0.5 min-w-0 rounded-lg px-2.5 py-1.5 text-sm break-words",
            message.kind === "task" ? "bg-primary/10" : message.kind === "report" ? "border border-border bg-background" : "bg-muted",
            // A height cap, not line-clamp: the Markdown renders blocks, which line-clamp does not cut.
            long && !open && "max-h-28 overflow-hidden",
          )}
          data-collapsed={long && !open ? "true" : undefined}
        >
          <MarkdownBody softBreaks>{message.text}</MarkdownBody>
        </div>
        {long ? (
          <button type="button" onClick={() => setOpen((value) => !value)} className="mt-0.5 text-xs text-muted-foreground hover:text-foreground">
            {open ? "Show less" : "Show all"}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** The teammates the lead put to work in this reply: who is on it, what they said to each other, and each one's work. */
function TeamAgents({ turn, live, onUndoEdit, disabled }: { turn: StudioAssistantTurn; live: boolean; onUndoEdit?: (editId: string) => Promise<void>; disabled?: boolean }) {
  const [view, setView] = useState<"chat" | "work">("chat");
  const agents = turn.agents ?? [];
  if (!agents.length) return null;
  const working = agents.filter((agent) => agent.status === "working").length;
  const chat = turn.teamChat ?? [];
  const talk = chat.filter((message) => message.kind === "message").length;
  const showChat = view === "chat" && chat.length > 0;
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card p-2.5" data-testid="studio-team-agents">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Users className="size-3.5" aria-hidden="true" />
        {working ? `${working} of ${agents.length} teammates working` : `Team of ${agents.length}`}
        {talk ? ` · ${talk} message${talk === 1 ? "" : "s"} between them` : ""}
      </span>
      <TeamRoster workers={turnWorkers(turn, { leadWorking: live })} />
      {chat.length ? (
        <div className="flex gap-1 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Team view">
          {(["chat", "work"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-xs",
                view === id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
              data-testid={`studio-team-view-${id}`}
            >
              {id === "chat" ? <MessageSquare className="size-3.5" aria-hidden="true" /> : <Users className="size-3.5" aria-hidden="true" />}
              {id === "chat" ? `Team chat (${chat.length})` : `Work (${agents.length})`}
            </button>
          ))}
        </div>
      ) : null}
      {showChat ? (
        <ol className="flex flex-col gap-2.5" data-testid="studio-team-chat" aria-live={live ? "polite" : undefined}>
          {chat.map((message) => (
            <TeamChatLine key={message.id} message={message} />
          ))}
        </ol>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {agents.map((agent) => (
            <TeamAgentCard key={agent.id} agent={agent} steps={turn.steps.filter((step) => step.agent === agent.id)} onUndoEdit={onUndoEdit} disabled={disabled} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the model is thinking right now: newest lines at the bottom, older ones fading. */
function LiveThinking({ text }: { text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="studio-live-thinking">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Brain className="size-3.5 text-(--status-agent-running)" aria-hidden="true" />
        <span className="shimmer-text shimmer-text-muted">Thinking…</span>
      </span>
      <div className="thinking-live ml-1.5 flex max-h-28 min-w-0 flex-col justify-end overflow-hidden border-l-2 border-border pl-2.5 text-xs text-muted-foreground" data-streaming="true">
        <MarkdownBody softBreaks>{settleStreamingMarkdown(text)}</MarkdownBody>
      </div>
    </div>
  );
}

/** Seconds as "42s" or "3:05". */
function formatElapsed(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * While the assistant works: what it is doing this moment, how many steps it
 * has taken, how long it has been, and a bar that keeps moving, so a long
 * install never looks frozen.
 */
function AssistantProgress({ turns, model }: { turns: StudioAssistantTurn[]; model: string }) {
  const lastUser = turns.findLast((turn) => turn.role === "user");
  const current = turns.at(-1)?.role === "assistant" ? turns.at(-1) : undefined;
  const startedAt = Date.parse(current?.createdAt ?? lastUser?.createdAt ?? "") || Date.now();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const steps = current?.steps.filter((step) => step.tool !== "say" && step.tool !== "think").length ?? 0;
  const teamWorking = current?.agents?.filter((agent) => agent.status === "working").length ?? 0;
  const doing = teamWorking > 1
    ? `${teamWorking} teammates working…`
    : current?.activity
    ? `${current.activity}…`
    : current?.liveThinking
      ? "Thinking it through…"
      : current?.live
        ? "Writing the reply…"
        : steps > 0
          ? "Deciding what to do next…"
          : `Waiting for ${modelDisplayName(current?.model ?? model)}…`;
  const elapsed = formatElapsed(Math.max(0, Math.round((now - startedAt) / 1000)));
  return (
    <li className="flex items-center gap-3" data-testid="studio-assistant-working">
      <Mascot pose="thinking" size="sm" className="size-12 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="truncate text-sm font-medium text-foreground" aria-live="polite" data-testid="studio-assistant-activity">
          {doing}
        </span>
        <ProgressBar label="The assistant is working" valueText={doing} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {steps === 1 ? "1 step done" : `${steps} steps done`} · {elapsed}
        </span>
      </div>
    </li>
  );
}

/** Tokens and cost of one reply, the way they count in Costs, and each model's share when a team worked on it. */
function UsageLine({ turn }: { turn: StudioAssistantTurn }) {
  const usage = turn.usage;
  if (!usage) return null;
  const cost = formatSpend(turn.provider, usage.costUsd);
  const workers = turnWorkers(turn).filter((worker) => worker.usage && worker.usage.inputTokens + worker.usage.outputTokens > 0);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground tabular-nums" data-testid="studio-turn-usage">
        {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out{cost ? ` · ${cost}` : ""}
      </span>
      {workers.length > 1 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Tokens per model" data-testid="studio-turn-usage-by-model">
          {workers.map((worker) => (
            <li key={worker.id} className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
              <ModelLogo modelId={worker.model} size="xs" tile={false} />
              <span className="max-w-28 truncate">{worker.lead ? `${worker.name} (lead)` : worker.name}</span>
              <span>{formatTokens(worker.usage!.inputTokens + worker.usage!.outputTokens)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Every model in this chat, with the tokens it used across replies (Free on the free models). */
function SessionUsageSummary({ turns }: { turns: StudioAssistantTurn[] }) {
  const models = modelTotals(turns).filter((model) => model.inputTokens + model.outputTokens > 0);
  if (!models.length) return null;
  const tokens = models.reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0);
  const allFree = models.every((model) => model.provider === "free");
  const knownCost = models.every((model) => model.provider === "free" || model.costUsd !== null);
  const cost = models.reduce((sum, model) => sum + (model.provider === "free" ? 0 : (model.costUsd ?? 0)), 0);
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5" data-testid="studio-session-usage">
      <span className="flex -space-x-1" aria-hidden="true">
        {models.slice(0, 5).map((model) => (
          <ModelLogo key={`${model.provider}:${model.model}`} modelId={model.model} size="xs" className="ring-1 ring-background" />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground">
        This chat: {formatTokens(tokens)} tokens{allFree ? " · Free" : knownCost ? ` · ${formatSpend(null, cost)}` : ""}
      </span>
      {models.length > 1 ? (
        <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-(length:--text-micro) font-medium text-primary">{models.length} models</span>
      ) : null}
    </li>
  );
}

/**
 * Studio's AI helper, on the free models or your own API key: describe what to build or fix
 * and it reads the files, writes code, runs commands, starts the app, and
 * checks the console until it works. Everyone in the project sees its
 * progress live.
 */
export function StudioAssistant({
  turns,
  running,
  keys,
  onSaveKey,
  onRemoveKey,
  onSend,
  onStop,
  onClear,
  onUndo,
  onUndoEdit,
  storageKey,
  initialPrompt,
  onInitialPromptUsed,
  companyId,
  previewReady = false,
  onShowPreview,
}: StudioAssistantProps) {
  const narrow = useNarrowScreen();
  // The newest reply in which the lead or a teammate started the app: it offers the page.
  const pageTurnId = turns.findLast((turn) => turn.role === "assistant" && turn.steps.some((step) => step.tool === "start_app" && step.ok))?.id ?? null;
  const [choice, setChoice] = useState<AiChoice>(() => readChoice(storageKey));
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const info = STUDIO_AI_PROVIDER_INFO[choice.provider];
  // Removing a key waits out an Undo window first (DESIGN.md: undo over
  // confirm); a failed removal brings the key back and says why.
  const keyRemoval = useUndoableAction({
    commit: async (provider) => {
      try {
        await onRemoveKey(provider as StudioAiProvider);
      } catch (removeError) {
        setError(removeError instanceof Error ? `Couldn't remove the key: ${removeError.message}` : "Couldn't remove the key");
        throw removeError;
      }
    },
  });
  const keyStatus = keyRemoval.hiddenIds.has(choice.provider)
    ? undefined
    : keys.find((key) => key.provider === choice.provider);
  // The free models need no key, also while the key list loads or fails to.
  const connected = choice.provider === "free" || Boolean(keyStatus?.connected);
  const showKeyForm = choice.provider !== "free" && (!connected || editingKey);

  // A saved choice with no key behind it (never added, or removed) starts on
  // the free models instead of asking for a key: the assistant always works.
  // Teammates with no key leave the team, since one missing key turns the
  // whole message down. Only on load: a provider picked now gets its key form.
  const pickedRef = useRef(false);
  const [freeInsteadOf, setFreeInsteadOf] = useState<string | null>(null);
  const [leftTeam, setLeftTeam] = useState<string | null>(null);
  useEffect(() => {
    if (pickedRef.current || !keys.length) return;
    const hasKey = (provider: StudioAiProvider) => provider === "free" || keys.some((key) => key.provider === provider && key.connected);
    const leadReady = hasKey(choice.provider);
    const keyless = (choice.team ?? []).filter((mate) => !hasKey(mate.provider));
    if (leadReady && !keyless.length) return;
    if (!leadReady) setFreeInsteadOf(STUDIO_AI_PROVIDER_INFO[choice.provider].name.replace(/ \(.*\)$/, ""));
    if (keyless.length) {
      const providers = [...new Set(keyless.map((mate) => STUDIO_AI_PROVIDER_INFO[mate.provider].name.replace(/ \(.*\)$/, "")))];
      setLeftTeam(`No ${providers.join(" or ")} key, so ${keyless.map((mate) => modelDisplayName(mate.model)).join(" and ")} left the team.`);
    }
    setChoice((current) => {
      const team = (current.team ?? []).filter((mate) => hasKey(mate.provider));
      return {
        ...(leadReady ? { provider: current.provider, model: current.model } : { provider: "free" as const, model: STUDIO_AI_PROVIDER_INFO.free.defaultModel }),
        ...(current.thinking ? { thinking: current.thinking } : {}),
        ...(team.length ? { team } : {}),
      };
    });
  }, [keys, choice.provider, choice.team]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(choice));
    } catch {
      // storage unavailable
    }
  }, [choice, storageKey]);

  // Follow a streaming reply only while the reader is at the bottom, so they
  // can scroll up to read earlier messages without being pulled back down.
  const stickRef = useRef(true);
  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [turns]);

  useEffect(() => {
    if (initialPrompt && !message) setMessage(initialPrompt);
    // Only when a new prompt arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const addFiles = async (files: File[]) => {
    setError(null);
    const room = STUDIO_ASSISTANT_MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setError(`Up to ${STUDIO_ASSISTANT_MAX_ATTACHMENTS} files per message.`);
      return;
    }
    const picked: PendingAttachment[] = [];
    for (const file of files.slice(0, room)) {
      try {
        picked.push(await toAttachment(file));
      } catch (readError) {
        setError(readError instanceof Error ? readError.message : "Couldn't read that file");
      }
    }
    if (picked.length) {
      haptic("tick");
      setAttachments((current) => [...current, ...picked.filter((item) => !current.some((existing) => existing.id === item.id))]);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const gone = current.find((item) => item.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  };

  const send = async (text: string) => {
    stickRef.current = true;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (!choice.model.trim()) {
      setError("Pick a model first: tap the model at the top.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSend(
        trimmed,
        choice.provider,
        choice.model.trim(),
        attachments.map((item) => item.input),
        effectiveStudioThinking(choice.provider, choice.model.trim(), choice.thinking),
        choice.team,
      );
      haptic("tick");
      setMessage("");
      for (const item of attachments) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      setAttachments([]);
      if (initialPrompt) onInitialPromptUsed?.();
    } catch (sendError) {
      haptic("warning");
      setError(sendError instanceof Error ? sendError.message : "Couldn't reach the assistant");
    } finally {
      setSending(false);
    }
  };

  // Stop and New chat say why they failed instead of doing nothing.
  const attempt = (action: () => Promise<void>, failed: string) => {
    setError(null);
    void action().catch((actionError) => {
      haptic("warning");
      setError(actionError instanceof Error ? `${failed}: ${actionError.message}` : failed);
    });
  };

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!keyInput.trim()) return;
    setSavingKey(true);
    setError(null);
    try {
      await onSaveKey(choice.provider, keyInput.trim(), baseUrlInput.trim() || null);
      haptic("success");
      setKeyInput("");
      setEditingKey(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Couldn't save the key");
    } finally {
      setSavingKey(false);
    }
  };

  // Provider, model, thinking and key. On a phone they scroll with the
  // conversation, so the messages get the whole height between the tabs.
  const header = (
      <div className="flex flex-col gap-2 border-b border-border p-3" data-testid="studio-assistant-settings">
        <StudioModelSheet
          provider={choice.provider}
          model={choice.model}
          keys={keys}
          companyId={companyId}
          team={choice.team ?? []}
          onTeamChange={(team) => {
            setLeftTeam(null);
            setChoice(({ team: _old, ...rest }) => (team.length ? { ...rest, team } : rest));
          }}
          onChange={(next) => {
            pickedRef.current = true;
            setFreeInsteadOf(null);
            setLeftTeam(null);
            if (next.provider !== choice.provider) setEditingKey(false);
            // The level and the team carry over to the next model.
            setChoice({ ...next, ...(choice.thinking ? { thinking: choice.thinking } : {}), ...(choice.team?.length ? { team: choice.team } : {}) });
          }}
        />
        {choice.team?.length ? (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="studio-team-chips">
            <Users className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="text-xs text-muted-foreground">Team:</span>
            {choice.team.map((mate) => (
              <span key={`${mate.provider}:${mate.model}`} className="inline-flex items-center gap-1 rounded-full border border-border bg-card py-0.5 pl-1 pr-1.5 text-xs">
                <ModelLogo modelId={mate.model} size="xs" tile={false} />
                <span className="max-w-32 truncate">{modelDisplayName(mate.model)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${modelDisplayName(mate.model)} from the team`}
                  className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setChoice(({ team: current = [], ...rest }) => {
                    const next = current.filter((m) => !(m.provider === mate.provider && m.model === mate.model));
                    return next.length ? { ...rest, team: next } : rest;
                  })}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <StudioThinkingControl
          provider={choice.provider}
          model={choice.model}
          value={choice.thinking}
          onChange={(thinking) => setChoice(({ thinking: _old, ...rest }) => (thinking ? { ...rest, thinking } : rest))}
        />
        {freeInsteadOf && choice.provider === "free" ? (
          <p className="text-xs text-muted-foreground" data-testid="studio-free-instead">
            No {freeInsteadOf} key yet, so the free models are answering: no key needed. To use {freeInsteadOf}, pick it in the model menu and add its key.
          </p>
        ) : null}
        {leftTeam ? (
          <p className="text-xs text-muted-foreground" data-testid="studio-team-left">
            {leftTeam}
          </p>
        ) : null}
        {choice.provider === "anthropic" && FALLBACK_MODELS.has(choice.model) ? (
          <p className="text-xs text-muted-foreground">Fallbacks are on: if Claude declines a request, Anthropic retries it on another Claude model.</p>
        ) : null}

        {showKeyForm ? (
          <form onSubmit={saveKey} className="flex flex-col gap-2" data-testid="studio-ai-key-form">
            <div className="flex items-center gap-2">
              <Input
                type="password"
                autoComplete="off"
                aria-label={`${info.name} API key`}
                placeholder={`Paste your ${info.name.replace(/ \(.*\)$/, "")} API key`}
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                className="h-9 font-mono text-sm"
              />
              <Button type="submit" size="sm" disabled={savingKey || !keyInput.trim()}>
                {savingKey ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
                Save
              </Button>
            </div>
            {choice.provider === "custom" || editingKey ? (
              <Input
                aria-label="API base URL"
                placeholder={choice.provider === "custom" ? "Base URL, e.g. https://api.example.com/v1" : "Base URL (optional)"}
                value={baseUrlInput}
                onChange={(event) => setBaseUrlInput(event.target.value)}
                className="h-9 font-mono text-sm"
              />
            ) : null}
            <p className="text-xs text-muted-foreground">
              Your key is encrypted on your Automa server and only used for this assistant.
              {info.keyUrl ? (
                <>
                  {" "}
                  <a href={info.keyUrl} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
                    Get a key
                  </a>
                </>
              ) : null}
            </p>
          </form>
        ) : choice.provider === "free" ? null : keyStatus?.source === "automa" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">
              Using your organization&apos;s {info.name.replace(/ \(.*\)$/, "")} key (
              <Link to="/company/settings/api-keys" className="underline underline-offset-2">Settings → API keys</Link>)
            </span>
            <Button variant="ghost" size="sm" onClick={() => setEditingKey(true)}>
              Use another
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">Key saved (ends in {keyStatus?.last4 ?? "…"})</span>
            <Button variant="ghost" size="sm" onClick={() => setEditingKey(true)}>
              Change
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setError(null);
                keyRemoval.run(choice.provider, `${info.name.replace(/ \(.*\)$/, "")} key removed`);
              }}
            >
              Remove
            </Button>
          </div>
        )}
      </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {narrow ? null : header}

      {/* Conversation */}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="studio-assistant-log"
      >
        {narrow ? header : null}
        <div className="p-3">
        {turns.length === 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Mascot pose="excited" size="sm" />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  <Sparkles className="size-4 text-primary" /> Tell me what to build
                </div>
                <p className="text-sm text-muted-foreground">I write the code, set up the database, run your app, and fix what breaks, right here in this project.</p>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={!connected || running}
                  onClick={() => setMessage(suggestion)}
                  className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="flex flex-col gap-4">
            <SessionUsageSummary turns={turns} />
            {turns.map((turn) =>
              turn.role === "user" ? (
                <li key={turn.id} className="ml-8 flex flex-col items-end gap-1 self-end">
                  {turn.attachments?.length ? (
                    <ul className="flex flex-wrap justify-end gap-1" aria-label="Attached files">
                      {turn.attachments.map((item) => (
                        <li key={`${item.name}:${item.size}`} className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground">
                          {item.type.startsWith("image/") ? <ImagePlus className="size-3" aria-hidden="true" /> : <Paperclip className="size-3" aria-hidden="true" />}
                          <span className="max-w-40 truncate">{item.name}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {turn.text ? <div className="rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">{turn.text}</div> : null}
                  {turn.checkpointId && onUndo ? (
                    <button
                      type="button"
                      disabled={running || undoing !== null}
                      onClick={() => {
                        if (confirmUndo !== turn.checkpointId) {
                          setConfirmUndo(turn.checkpointId!);
                          return;
                        }
                        setUndoing(turn.checkpointId!);
                        void onUndo(turn.checkpointId!).finally(() => {
                          setUndoing(null);
                          setConfirmUndo(null);
                        });
                      }}
                      className={cn(
                        "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs disabled:opacity-50",
                        confirmUndo === turn.checkpointId ? "bg-destructive/15 text-destructive" : "text-muted-foreground hover:text-foreground",
                      )}
                      data-testid="studio-undo-ai"
                    >
                      {undoing === turn.checkpointId ? <LoaderCircle className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
                      {confirmUndo === turn.checkpointId ? "Tap again to undo the AI's changes" : "Undo AI changes"}
                    </button>
                  ) : null}
                </li>
              ) : (
                <li key={turn.id} className="flex min-w-0 flex-col gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ModelLogo modelId={turn.model ?? "claude"} size="xs" />
                    {modelDisplayName(turn.model)}
                  </span>
                  {/* Teammates' own steps live in their cards, not in the lead's flow. */}
                  {groupSteps(turn.steps.filter((step) => !step.agent)).map((group, index) =>
                    group.kind === "say" ? (
                      <div key={index} className="min-w-0 text-sm break-words">
                        <MarkdownBody softBreaks>{group.text}</MarkdownBody>
                      </div>
                    ) : (
                      <ul key={index} className="flex flex-col gap-1 border-l-2 border-border pl-2">
                        {group.steps.map((step, stepIndex) =>
                          step.tool === "think" ? <ThoughtRow key={stepIndex} step={step} /> : <StepRow key={stepIndex} step={step} onUndoEdit={onUndoEdit} disabled={running} />,
                        )}
                      </ul>
                    ),
                  )}
                  <TeamAgents turn={turn} live={running && turn.id === turns.at(-1)?.id} onUndoEdit={onUndoEdit} disabled={running} />
                  {/* Transcripts from before steps carried the text. */}
                  {turn.text && !turn.steps.some((step) => step.tool === "say") ? (
                    <div className="min-w-0 text-sm break-words">
                      <MarkdownBody softBreaks>{turn.text}</MarkdownBody>
                    </div>
                  ) : null}
                  {turn.liveThinking ? <LiveThinking text={turn.liveThinking} /> : null}
                  {turn.live ? (
                    <div className="min-w-0 text-sm break-words" data-streaming="true" data-testid="studio-live-text">
                      <MarkdownBody softBreaks>{settleStreamingMarkdown(turn.live)}</MarkdownBody>
                    </div>
                  ) : null}
                  {turn.error ? <p className="text-sm text-destructive">{turn.error}</p> : null}
                  {turn.id === pageTurnId && previewReady && onShowPreview ? (
                    <Button type="button" variant="secondary" size="sm" className="self-start" onClick={onShowPreview} data-testid="studio-open-page">
                      <Globe /> Open the page
                    </Button>
                  ) : null}
                  <UsageLine turn={turn} />
                </li>
              ),
            )}
            {running ? <AssistantProgress turns={turns} model={choice.model} /> : null}
          </ol>
        )}
        </div>
      </div>

      {/* Composer */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(message);
        }}
        className="flex flex-col gap-2 border-t border-border p-2 pb-(--sz-safe-bottom)"
      >
        {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
        {attachments.length ? (
          <ul className="flex flex-wrap gap-2" aria-label="Files to send">
            {attachments.map((item) => (
              <li key={item.id} className="relative flex items-center gap-2 rounded-lg border border-border bg-card p-1 pr-2 text-xs">
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt="" className="size-10 rounded-md object-cover" />
                ) : (
                  <span className="flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Paperclip className="size-4" aria-hidden="true" />
                  </span>
                )}
                <span className="max-w-32 truncate">{item.file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${item.file.name}`}
                  onClick={() => removeAttachment(item.id)}
                  className="ml-1 flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send(message);
            }
          }}
          rows={2}
          disabled={!connected}
          placeholder={connected ? "Describe what to build or fix…" : "Add your API key above to start"}
          aria-label="Message the assistant"
          className="max-h-40 min-h-16 resize-none text-sm"
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Attach an image or a text file"
            title="Attach an image or a text file"
            disabled={!connected || running}
            onClick={() => fileInputRef.current?.click()}
            data-testid="studio-assistant-attach"
          >
            <Paperclip />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={[...STUDIO_ASSISTANT_IMAGE_TYPES, ".txt,.md,.json,.js,.ts,.tsx,.jsx,.css,.html,.py,.go,.rs,.java,.kt,.sql,.yaml,.yml,.toml,.csv,.sh,.env"].join(",")}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length) void addFiles(files);
            }}
          />
          {turns.length ? (
            <Button type="button" variant="ghost" size="sm" disabled={running} onClick={() => attempt(onClear, "Couldn't start a new chat")}>
              <Trash2 /> New chat
            </Button>
          ) : null}
          <span className="flex-1" />
          {running ? (
            <Button type="button" variant="outline" size="sm" onClick={() => attempt(onStop, "Couldn't stop the assistant")}>
              <CircleStop /> Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={!connected || sending || (!message.trim() && attachments.length === 0)}>
              {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
