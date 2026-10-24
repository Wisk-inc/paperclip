import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brain, Check, ChevronRight, CircleAlert, CircleStop, ImagePlus, KeyRound, LoaderCircle, Paperclip, Send, Sparkles, Trash2, Undo2, X } from "lucide-react";
import {
  STUDIO_AI_PROVIDERS,
  STUDIO_AI_PROVIDER_INFO,
  STUDIO_ASSISTANT_IMAGE_TYPES,
  STUDIO_ASSISTANT_MAX_ATTACHMENTS,
  STUDIO_ASSISTANT_MAX_IMAGE_BYTES,
  STUDIO_ASSISTANT_MAX_TEXT_BYTES,
  STUDIO_THINKING_LEVELS,
  type StudioAiKeyStatus,
  type StudioAiProvider,
  type StudioAssistantAttachmentInput,
  type StudioAssistantStep,
  type StudioAssistantTurn,
  type StudioThinkingLevel,
} from "@paperclipai/shared";
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
  ) => Promise<void>;
  onStop: () => Promise<void>;
  onClear: () => Promise<void>;
  /** Goes back to the checkpoint saved before a message. */
  onUndo?: (checkpointId: string) => Promise<void>;
  /** Remembers the provider, model and thinking level per organization. */
  storageKey: string;
  /** A first message to send once a key is ready (from "describe your app"). */
  initialPrompt?: string | null;
  onInitialPromptUsed?: () => void;
}

interface AiChoice {
  provider: StudioAiProvider;
  model: string;
  thinking?: StudioThinkingLevel;
}

function readChoice(storageKey: string): AiChoice {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { provider?: string; model?: string; thinking?: string };
      if (parsed.provider && (STUDIO_AI_PROVIDERS as readonly string[]).includes(parsed.provider)) {
        const thinking = (STUDIO_THINKING_LEVELS as readonly string[]).includes(parsed.thinking ?? "")
          ? (parsed.thinking as StudioThinkingLevel)
          : undefined;
        return {
          provider: parsed.provider as StudioAiProvider,
          model: parsed.model || STUDIO_AI_PROVIDER_INFO[parsed.provider as StudioAiProvider].defaultModel,
          ...(thinking ? { thinking } : {}),
        };
      }
    }
  } catch {
    // storage unavailable
  }
  return { provider: "anthropic", model: STUDIO_AI_PROVIDER_INFO.anthropic.defaultModel };
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

function StepRow({ step }: { step: StudioAssistantStep }) {
  const summary = step.summary || TOOL_LABEL[step.tool] || step.tool;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("flex items-center gap-1.5 text-xs", step.ok ? "text-muted-foreground" : "text-destructive")}>
        {step.ok ? <Check className="size-3 shrink-0" /> : <CircleAlert className="size-3 shrink-0" />}
        <span className="truncate font-mono">{summary}</span>
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
  const doing = current?.activity
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

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/** Tokens and cost of one reply, the way they count in Costs. */
function UsageLine({ usage }: { usage: NonNullable<StudioAssistantTurn["usage"]> }) {
  const cost = usage.costUsd === null ? null : usage.costUsd < 0.01 ? "under 1¢" : `$${usage.costUsd.toFixed(2)}`;
  return (
    <span className="text-xs text-muted-foreground tabular-nums" data-testid="studio-turn-usage">
      {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out{cost ? ` · ${cost}` : ""}
    </span>
  );
}

/**
 * Studio's AI helper, using your own API key: describe what to build or fix
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
  storageKey,
  initialPrompt,
  onInitialPromptUsed,
}: StudioAssistantProps) {
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
  const connected = Boolean(keyStatus?.connected);
  const showKeyForm = !connected || editingKey;

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
    if ((!trimmed && attachments.length === 0) || !choice.model.trim()) return;
    setSending(true);
    setError(null);
    try {
      await onSend(
        trimmed,
        choice.provider,
        choice.model.trim(),
        attachments.map((item) => item.input),
        effectiveStudioThinking(choice.provider, choice.model.trim(), choice.thinking),
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Provider and model */}
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <StudioModelSheet
          provider={choice.provider}
          model={choice.model}
          keys={keys}
          onChange={(next) => {
            if (next.provider !== choice.provider) setEditingKey(false);
            // The level carries over to the next model when it takes it too.
            setChoice({ ...next, ...(choice.thinking ? { thinking: choice.thinking } : {}) });
          }}
        />
        <StudioThinkingControl
          provider={choice.provider}
          model={choice.model}
          value={choice.thinking}
          onChange={(thinking) => setChoice(({ thinking: _old, ...rest }) => (thinking ? { ...rest, thinking } : rest))}
        />
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
        ) : keyStatus?.source === "automa" ? (
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

      {/* Conversation */}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto p-3"
        data-testid="studio-assistant-log"
      >
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
                  {groupSteps(turn.steps).map((group, index) =>
                    group.kind === "say" ? (
                      <div key={index} className="min-w-0 text-sm break-words">
                        <MarkdownBody softBreaks>{group.text}</MarkdownBody>
                      </div>
                    ) : (
                      <ul key={index} className="flex flex-col gap-1 border-l-2 border-border pl-2">
                        {group.steps.map((step, stepIndex) =>
                          step.tool === "think" ? <ThoughtRow key={stepIndex} step={step} /> : <StepRow key={stepIndex} step={step} />,
                        )}
                      </ul>
                    ),
                  )}
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
                  {turn.usage ? <UsageLine usage={turn.usage} /> : null}
                </li>
              ),
            )}
            {running ? <AssistantProgress turns={turns} model={choice.model} /> : null}
          </ol>
        )}
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
            <Button type="button" variant="ghost" size="sm" disabled={running} onClick={() => void onClear()}>
              <Trash2 /> New chat
            </Button>
          ) : null}
          <span className="flex-1" />
          {running ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void onStop()}>
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
