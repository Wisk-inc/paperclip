import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, CircleAlert, CircleStop, KeyRound, LoaderCircle, Send, Sparkles, Trash2 } from "lucide-react";
import {
  STUDIO_AI_PROVIDERS,
  STUDIO_AI_PROVIDER_INFO,
  type StudioAiKeyStatus,
  type StudioAiProvider,
  type StudioAssistantStep,
  type StudioAssistantTurn,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ModelLogo } from "@/components/ModelLogo";
import { modelDisplayName } from "@/lib/model-brand";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { Mascot } from "../mascot/Mascot";

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
  onSend: (message: string, provider: StudioAiProvider, model: string) => Promise<void>;
  onStop: () => Promise<void>;
  onClear: () => Promise<void>;
  /** Remembers the provider and model per organization. */
  storageKey: string;
  /** A first message to send once a key is ready (from "describe your app"). */
  initialPrompt?: string | null;
  onInitialPromptUsed?: () => void;
}

function readChoice(storageKey: string): { provider: StudioAiProvider; model: string } {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { provider?: string; model?: string };
      if (parsed.provider && (STUDIO_AI_PROVIDERS as readonly string[]).includes(parsed.provider)) {
        return { provider: parsed.provider as StudioAiProvider, model: parsed.model || STUDIO_AI_PROVIDER_INFO[parsed.provider as StudioAiProvider].defaultModel };
      }
    }
  } catch {
    // storage unavailable
  }
  return { provider: "anthropic", model: STUDIO_AI_PROVIDER_INFO.anthropic.defaultModel };
}

type StepGroup = { kind: "say"; text: string } | { kind: "tools"; steps: StudioAssistantStep[] };

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
  storageKey,
  initialPrompt,
  onInitialPromptUsed,
}: StudioAssistantProps) {
  const [choice, setChoice] = useState(() => readChoice(storageKey));
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const info = STUDIO_AI_PROVIDER_INFO[choice.provider];
  const keyStatus = keys.find((key) => key.provider === choice.provider);
  const connected = Boolean(keyStatus?.connected);
  const showKeyForm = !connected || editingKey;

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(choice));
    } catch {
      // storage unavailable
    }
  }, [choice, storageKey]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns]);

  useEffect(() => {
    if (initialPrompt && !message) setMessage(initialPrompt);
    // Only when a new prompt arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const modelOptions = useMemo(() => {
    const list = [...info.models];
    if (choice.model && !list.includes(choice.model)) list.unshift(choice.model);
    return list;
  }, [info.models, choice.model]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !choice.model.trim()) return;
    setSending(true);
    setError(null);
    try {
      await onSend(trimmed, choice.provider, choice.model.trim());
      haptic("tick");
      setMessage("");
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
        <div className="flex items-center gap-2">
          <ModelLogo modelId={choice.provider === "anthropic" ? choice.model : choice.model || choice.provider} size="sm" />
          <select
            aria-label="AI provider"
            value={choice.provider}
            onChange={(event) => {
              const provider = event.target.value as StudioAiProvider;
              setChoice({ provider, model: STUDIO_AI_PROVIDER_INFO[provider].defaultModel });
              setEditingKey(false);
            }}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          >
            {STUDIO_AI_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {STUDIO_AI_PROVIDER_INFO[provider].name}
              </option>
            ))}
          </select>
        </div>
        {modelOptions.length ? (
          <select
            aria-label="Model"
            value={choice.model}
            onChange={(event) => setChoice((current) => ({ ...current, model: event.target.value }))}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {modelDisplayName(model)}
              </option>
            ))}
          </select>
        ) : (
          <Input
            aria-label="Model name"
            placeholder="Model name, e.g. llama-3.3-70b"
            value={choice.model}
            onChange={(event) => setChoice((current) => ({ ...current, model: event.target.value }))}
            className="h-9 font-mono text-sm"
          />
        )}
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
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">Key saved (ends in {keyStatus?.last4 ?? "…"})</span>
            <Button variant="ghost" size="xs" onClick={() => setEditingKey(true)}>
              Change
            </Button>
            <Button variant="ghost" size="xs" onClick={() => void onRemoveKey(choice.provider)}>
              Remove
            </Button>
          </div>
        )}
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="studio-assistant-log">
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
                <li key={turn.id} className="ml-8 self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                  {turn.text}
                </li>
              ) : (
                <li key={turn.id} className="flex flex-col gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ModelLogo modelId={turn.model ?? "claude"} size="xs" />
                    {modelDisplayName(turn.model)}
                  </span>
                  {groupSteps(turn.steps).map((group, index) =>
                    group.kind === "say" ? (
                      <div key={index} className="text-sm whitespace-pre-wrap break-words">
                        {group.text}
                      </div>
                    ) : (
                      <ul key={index} className="flex flex-col gap-1 border-l-2 border-border pl-2">
                        {group.steps.map((step, stepIndex) => (
                          <StepRow key={stepIndex} step={step} />
                        ))}
                      </ul>
                    ),
                  )}
                  {/* Transcripts from before steps carried the text. */}
                  {turn.text && !turn.steps.some((step) => step.tool === "say") ? <div className="text-sm whitespace-pre-wrap break-words">{turn.text}</div> : null}
                  {turn.live ? <div className="text-sm whitespace-pre-wrap break-words">{turn.live}</div> : null}
                  {turn.error ? <p className="text-sm text-destructive">{turn.error}</p> : null}
                </li>
              ),
            )}
            {running ? (
              <li className="flex items-center gap-3 text-sm text-muted-foreground" data-testid="studio-assistant-working">
                <Mascot pose="thinking" size="sm" className="size-12" />
                <span className="flex items-center gap-2">
                  <LoaderCircle className="size-4 animate-spin" /> Working on it…
                </span>
              </li>
            ) : null}
          </ol>
        )}
      </div>

      {/* Composer */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(message);
        }}
        className="flex flex-col gap-2 border-t border-border p-2"
      >
        {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
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
            <Button type="submit" size="sm" disabled={!connected || sending || !message.trim()}>
              {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
