import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, Check, ChevronDown, CircleAlert, CircleStop, KeyRound, LoaderCircle, MessageSquarePlus, Send, X } from "lucide-react";
import { freeModelAnswering, pickAnsweringFreeModel, resolveFreeModel, type FreeModelHealthMap } from "@paperclipai/shared";
import {
  appInspectorApi,
  INSPECTOR_CHAT_CLAUDE,
  INSPECTOR_CHAT_MAX_MESSAGE,
  type InspectorChatMessage,
  type InspectorChatView,
  type InspectorView,
} from "@/api/app-inspector";
import { ApiError } from "@/api/client";
import { freeModelsApi } from "@/api/free-models";
import { isServerTooOld, PhoneServerOutdated, retryUnlessServerTooOld } from "@/components/device/PhoneServerOutdated";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Mascot } from "@/components/mascot/Mascot";
import { ModelLogo } from "@/components/ModelLogo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToastActions } from "@/context/ToastContext";
import { UNDO_WINDOW_MS } from "@/hooks/useUndoableAction";
import { haptic } from "@/lib/haptics";
import { modelDisplayName } from "@/lib/model-brand";
import { queryKeys } from "@/lib/queryKeys";
import { handleRadioGroupKeyDown, radioTabIndex } from "@/lib/radio-group-keys";
import { cn } from "@/lib/utils";
import { fileKind } from "./file-kinds";

/** The file a question is about. */
export interface InspectorChatFile {
  path: string;
  view: InspectorView;
}

/** A question on its way to a model. */
interface Asking {
  text: string;
  file: InspectorChatFile | null;
  model: string;
  startedAt: number;
  controller: AbortController;
}

/** A question that got no answer. The server saved nothing, so the text is kept here to ask again. */
interface Unanswered {
  text: string;
  file: InspectorChatFile | null;
  model: string;
  /** Why, in the server's words. */
  message: string;
  /** The free model to offer instead: only when the model itself could not answer, once the models' states were read again. */
  suggest: string | null;
}

interface Thread {
  asking: Asking | null;
  unanswered: Unanswered | null;
}

// Kept outside the component, by project: an answer takes up to a minute, and closing the
// chat to look at the file must not lose the question or what became of it.
const IDLE: Thread = { asking: null, unanswered: null };
const threads = new Map<string, Thread>();
const watchers = new Set<() => void>();

function setThread(key: string, patch: Partial<Thread>) {
  threads.set(key, { ...(threads.get(key) ?? IDLE), ...patch });
  for (const notify of watchers) notify();
}

function watchThreads(notify: () => void) {
  watchers.add(notify);
  return () => {
    watchers.delete(notify);
  };
}

/** Forgets questions on their way (tests). */
export function __resetInspectorChat() {
  threads.clear();
}

const MODEL_STORAGE_KEY = "automa.inspector.chat.model";

function storedModel(): string | null {
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeModel(model: string) {
  try {
    window.localStorage.setItem(MODEL_STORAGE_KEY, model);
  } catch {
    // storage unavailable
  }
}

const FILE_SUGGESTIONS = ["Explain what this file does", "What should I look at in this file?", "How would I change what this does?"];
const APP_SUGGESTIONS = ["What does this app do?", "Where does it talk to the network?", "Which files should I read first?"];
const NO_MESSAGES: InspectorChatMessage[] = [];
const NO_MODELS: string[] = [];

function fileName(path: string) {
  return path.split("/").pop() ?? path;
}

function chatModelName(model: string | null | undefined) {
  return model === INSPECTOR_CHAT_CLAUDE ? "Claude" : modelDisplayName(model);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ChatModelLogo({ model, size = "xs" }: { model: string | null | undefined; size?: "xs" | "sm" }) {
  return model === INSPECTOR_CHAT_CLAUDE ? <ModelLogo provider="anthropic" size={size} /> : <ModelLogo modelId={model} size={size} />;
}

/** The file's typed icon, as the file list shows it. */
function FileIcon({ path, className }: { path: string; className?: string }) {
  const kind = fileKind(fileName(path), false);
  return <kind.icon className={cn("shrink-0", kind.tone, className)} aria-hidden="true" />;
}

/** The file a question was asked about, by name; the whole path on hover. */
function FileChip({ path }: { path: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground" title={path} data-testid="inspector-chat-file">
      <FileIcon path={path} className="size-3" />
      <span className="truncate">{fileName(path)}</span>
    </span>
  );
}

function PersonMessage({ text, path, faded, children }: { text: string; path?: string | null; faded?: boolean; children?: React.ReactNode }) {
  return (
    <li className="ml-8 flex max-w-full min-w-0 flex-col items-end gap-1 self-end" data-role="user">
      {path ? <FileChip path={path} /> : null}
      <div className={cn("max-w-full rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm wrap-anywhere whitespace-pre-wrap text-primary-foreground", faded && "opacity-60")}>{text}</div>
      {children}
    </li>
  );
}

/**
 * The App Inspector's own chat: questions about a decoded app, or about the file open in the
 * editor, answered by a free model (no key needed) or by Claude on the person's Anthropic key.
 * The model named in the header is the one asked. When it can't answer, the question stays on
 * screen with the reason, and another model is asked only when the person taps it.
 */
export function InspectorChat({
  companyId,
  projectId,
  appName,
  file: openedFile = null,
  fileUnsaved = false,
  onAskAgent,
  onClose,
}: {
  companyId: string;
  projectId: string;
  /** Shown under the title. */
  appName: string;
  /** The file the chat was opened from; without one the questions are about the whole app. */
  file?: InspectorChatFile | null;
  /** The editor holds changes to that file that are not saved yet; the model reads the saved file. */
  fileUnsaved?: boolean;
  /** Opens a chat with one of the organization's agents, which have file and device tools this chat does not. */
  onAskAgent?: () => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const threadKey = `${companyId}:${projectId}`;
  const chatKey = useMemo(() => ["inspector", "chat", companyId, projectId] as const, [companyId, projectId]);
  const chat = useQuery({ queryKey: chatKey, queryFn: () => appInspectorApi.chat(companyId, projectId), retry: retryUnlessServerTooOld });
  const health = useQuery({ queryKey: queryKeys.freeModels.health(), queryFn: () => freeModelsApi.health(), staleTime: 30_000 });
  const { asking, unanswered } = useSyncExternalStore(watchThreads, () => threads.get(threadKey) ?? IDLE);

  const [file, setFile] = useState<InspectorChatFile | null>(openedFile);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const clearTimer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const models = chat.data?.models ?? NO_MODELS;
  const claude = chat.data?.claude ?? false;
  const options = useMemo(() => (claude ? [...models, INSPECTOR_CHAT_CLAUDE] : models), [models, claude]);
  const messages = clearing ? NO_MESSAGES : (chat.data?.messages ?? NO_MESSAGES);

  // The model starts as the one picked the last time when it is still offered, else the
  // first free model answering now. After that it changes only on the person's tap.
  useEffect(() => {
    if (model || !chat.data) return;
    const stored = storedModel();
    const offered = stored !== null && (stored === INSPECTOR_CHAT_CLAUDE ? chat.data.claude : chat.data.models.includes(stored));
    setModel(offered ? stored : chat.data.defaultModel);
  }, [chat.data, model]);

  const pickModel = (next: string) => {
    setModel(next);
    storeModel(next);
  };

  // Follow the conversation only while the reader is at the bottom, so they can
  // scroll up to an earlier answer without being pulled back down.
  const stickRef = useRef(true);
  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [messages, asking, unanswered]);

  // The seconds a reply has been in the making.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!asking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [asking]);
  const seconds = asking ? Math.max(0, Math.floor((now - asking.startedAt) / 1000)) : 0;

  /**
   * Sends a New chat that is waiting out its Undo window to the server now.
   * False when the server refused; the conversation is read again then.
   */
  const commitClear = useCallback(async (): Promise<boolean> => {
    if (clearTimer.current === null) return true;
    window.clearTimeout(clearTimer.current);
    clearTimer.current = null;
    const emptied = (old: InspectorChatView | undefined) => (old ? { ...old, messages: [] } : old);
    client.setQueryData<InspectorChatView>(chatKey, emptied);
    setClearing(false);
    try {
      await appInspectorApi.clearChat(companyId, projectId);
      await client.cancelQueries({ queryKey: chatKey });
      client.setQueryData<InspectorChatView>(chatKey, emptied);
      return true;
    } catch (error) {
      setClearError(errorText(error));
      void client.invalidateQueries({ queryKey: chatKey });
      return false;
    }
  }, [client, chatKey, companyId, projectId]);
  const commitClearRef = useRef(commitClear);
  commitClearRef.current = commitClear;
  // Closing the chat inside the Undo window still clears it: the person asked for that.
  useEffect(() => () => void commitClearRef.current(), []);

  const newChat = () => {
    if (asking || clearTimer.current !== null) return;
    haptic("tick");
    setClearError(null);
    setThread(threadKey, { unanswered: null });
    if (!messages.length) return;
    // Undo over confirm: the conversation leaves at once, and the server is told when the Undo window closes.
    setClearing(true);
    clearTimer.current = window.setTimeout(() => void commitClearRef.current(), UNDO_WINDOW_MS);
    pushToast({
      title: "Chat cleared",
      tone: "info",
      ttlMs: UNDO_WINDOW_MS,
      action: {
        label: "Undo",
        onClick: () => {
          if (clearTimer.current === null) return;
          window.clearTimeout(clearTimer.current);
          clearTimer.current = null;
          setClearing(false);
        },
      },
    });
  };

  const ask = async (text: string, about: InspectorChatFile | null, withModel: string) => {
    const message = text.trim();
    if (!message || threads.get(threadKey)?.asking) return;
    stickRef.current = true;
    haptic("tick");
    const controller = new AbortController();
    setThread(threadKey, { asking: { text: message, file: about, model: withModel, startedAt: Date.now(), controller }, unanswered: null });
    try {
      // A New chat still inside its Undo window comes first, or it would clear this question too.
      if (!(await commitClear())) {
        setThread(threadKey, { asking: null });
        setDraft((current) => current || message);
        return;
      }
      const result = await appInspectorApi.askChat(
        companyId,
        projectId,
        { message, ...(about ? { path: about.path, view: about.view } : {}), model: withModel },
        { signal: controller.signal },
      );
      // A read of the conversation that started before the answer was saved must not put the old one back.
      await client.cancelQueries({ queryKey: chatKey });
      client.setQueryData<InspectorChatView>(chatKey, (old) => (old ? { ...old, messages: result.messages } : old));
      setThread(threadKey, { asking: null });
      haptic("success");
    } catch (error) {
      // Stopped by the person: stop() already put the question back in the box.
      if (controller.signal.aborted) return;
      haptic("warning");
      const failure: Unanswered = { text: message, file: about, model: withModel, message: errorText(error), suggest: null };
      setThread(threadKey, { asking: null, unanswered: failure });
      // 503: the model itself could not answer. Offer one that answered when it was last asked,
      // from the states as they are now; asking it stays the person's tap.
      if (!(error instanceof ApiError) || error.status !== 503) return;
      const states = await client
        .fetchQuery({ queryKey: queryKeys.freeModels.health(), queryFn: () => freeModelsApi.health(), staleTime: 0 })
        .catch((): FreeModelHealthMap => ({}));
      const suggest = pickAnsweringFreeModel(models, states, { except: withModel, proven: true });
      if (threads.get(threadKey)?.unanswered === failure) setThread(threadKey, { unanswered: { ...failure, suggest } });
    }
  };

  const send = () => {
    if (!model || !draft.trim() || asking) return;
    const text = draft;
    setDraft("");
    void ask(text, file, model);
  };

  const stop = () => {
    if (!asking) return;
    asking.controller.abort();
    setThread(threadKey, { asking: null });
    // Back in the box, to change or send again.
    setDraft((current) => current || asking.text);
    // The answer may have been saved in the moment Stop was tapped.
    void client.invalidateQueries({ queryKey: chatKey });
  };

  const editUnanswered = () => {
    if (!unanswered) return;
    setDraft(unanswered.text);
    setFile(unanswered.file);
    setThread(threadKey, { unanswered: null });
    inputRef.current?.focus();
  };

  const modelLabel = model === INSPECTOR_CHAT_CLAUDE ? "Claude (your key)" : chatModelName(model);
  const suggestions = file ? FILE_SUGGESTIONS : APP_SUGGESTIONS;
  const empty = messages.length === 0 && !asking && !unanswered;

  return (
    <div
      className="studio-ide-immersive fixed inset-0 z-50 flex flex-col bg-background pt-(--sz-safe-top) pb-(--sz-safe-bottom) md:left-auto md:w-full md:max-w-xl md:border-l md:border-border md:shadow-xl"
      role="dialog"
      aria-label={`Chat about ${appName}`}
      data-testid="inspector-chat"
    >
      <header className="flex items-center gap-1 border-b border-border px-1 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="Close the chat" onClick={onClose} data-testid="inspector-chat-close">
          <ArrowLeft />
        </Button>
        <span className="min-w-0 flex-1 px-1">
          <span className="block truncate text-sm font-semibold">Chat</span>
          <span className="block truncate text-xs text-muted-foreground">{appName}</span>
        </span>
        <button
          ref={menuButtonRef}
          type="button"
          disabled={!model}
          onClick={() => {
            haptic("tick");
            setMenuOpen(true);
          }}
          className="flex h-9 max-w-44 min-w-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-sm transition-colors duration-(--motion-duration-fast) hover:bg-accent/40 disabled:opacity-50"
          aria-label={`Model: ${modelLabel}. Change`}
          data-testid="inspector-chat-model"
          data-model={model ?? ""}
        >
          <ChatModelLogo model={model} />
          <span className="truncate">{model ? modelLabel : "Model"}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New chat"
          title="New chat"
          disabled={Boolean(asking) || (messages.length === 0 && !unanswered)}
          onClick={newChat}
          data-testid="inspector-chat-clear"
        >
          <MessageSquarePlus />
        </Button>
      </header>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"
        data-testid="inspector-chat-log"
      >
        {chat.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="ml-auto h-10 w-2/3" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : chat.isError && isServerTooOld(chat.error) ? (
          // The app is newer than the Automa server on this phone, which has no chat yet.
          <PhoneServerOutdated feature="The App Inspector's chat" onRetry={() => void chat.refetch()} />
        ) : chat.isError ? (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm" role="alert">
            <p className="text-destructive">{errorText(chat.error)}</p>
            <Button variant="outline" size="sm" onClick={() => void chat.refetch()}>
              Try again
            </Button>
          </div>
        ) : empty ? (
          <div className="flex flex-col items-center gap-4 px-2 py-6 text-center" data-testid="inspector-chat-empty">
            <Mascot pose="thinking" size="md" />
            <div className="flex max-w-md flex-col gap-1">
              <p className="font-display text-lg font-semibold tracking-tight">{file ? <>Ask about {fileName(file.path)}</> : "Ask about this app"}</p>
              <p className="text-sm text-muted-foreground">
                {file
                  ? "The model reads this file and the app's summary. The free models need no key."
                  : "The model reads the app's summary and the files you name in your question. The free models need no key."}
              </p>
            </div>
            <div className="flex w-full max-w-md flex-col gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setDraft(suggestion);
                    inputRef.current?.focus();
                  }}
                  className="min-h-11 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-accent"
                  data-testid="inspector-chat-suggestion"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="flex flex-col gap-4">
            {messages.map((message) =>
              message.role === "user" ? (
                <PersonMessage key={message.id} text={message.text} path={message.path} />
              ) : (
                <li key={message.id} className="flex min-w-0 flex-col gap-2" data-role="assistant">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ChatModelLogo model={message.model} />
                    {chatModelName(message.model)}
                  </span>
                  <div className="min-w-0 text-sm break-words">
                    <MarkdownBody softBreaks>{message.text}</MarkdownBody>
                  </div>
                </li>
              ),
            )}

            {asking ? (
              <>
                <PersonMessage text={asking.text} path={asking.file?.path} />
                <li className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="inspector-chat-writing">
                  <ChatModelLogo model={asking.model} />
                  <span role="status">{chatModelName(asking.model)} is writing</span>
                  <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                  <span className="font-mono tabular-nums" aria-hidden="true">{seconds}s</span>
                </li>
              </>
            ) : null}

            {unanswered ? (
              <>
                <PersonMessage text={unanswered.text} path={unanswered.file?.path} faded>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    Not sent
                    <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={editUnanswered} data-testid="inspector-chat-edit">
                      Edit
                    </button>
                  </span>
                </PersonMessage>
                <li className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3" role="alert" data-testid="inspector-chat-notice">
                  <p className="flex items-start gap-2 text-sm">
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 wrap-anywhere">{unanswered.message}</span>
                  </p>
                  {/* One row: the same model on the left, the other model on the right. */}
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={!model}
                      onClick={() => model && void ask(unanswered.text, unanswered.file, model)}
                      data-testid="inspector-chat-retry"
                    >
                      Try again
                    </Button>
                    {unanswered.suggest ? (
                      <Button
                        size="sm"
                        // A long model name is cut short instead of pushing the button out of the notice.
                        className="min-w-0 shrink"
                        onClick={() => {
                          const next = unanswered.suggest!;
                          pickModel(next);
                          void ask(unanswered.text, unanswered.file, next);
                        }}
                        title={`Ask ${chatModelName(unanswered.suggest)} instead`}
                        data-testid="inspector-chat-switch-model"
                        data-model={unanswered.suggest}
                      >
                        <ChatModelLogo model={unanswered.suggest} />
                        <span className="truncate">Ask {chatModelName(unanswered.suggest)} instead</span>
                      </Button>
                    ) : null}
                  </div>
                </li>
              </>
            ) : null}
          </ol>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        className="flex flex-col gap-2 border-t border-border p-2"
      >
        {clearError ? (
          <p className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs" role="alert">
            <span className="min-w-0 flex-1 wrap-anywhere">Couldn't start a new chat: {clearError}</span>
            <button type="button" aria-label="Dismiss" className="text-muted-foreground hover:text-foreground" onClick={() => setClearError(null)}>
              <X className="size-4" aria-hidden="true" />
            </button>
          </p>
        ) : null}
        {file ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card pl-3 text-sm" data-testid="inspector-chat-about">
            <FileIcon path={file.path} className="size-4" />
            <span className="min-w-0 flex-1 truncate">
              About {fileName(file.path)}
              {fileUnsaved && file.path === openedFile?.path ? <span className="text-muted-foreground"> (as last saved)</span> : null}
            </span>
            <button
              type="button"
              aria-label="Ask about the whole app instead"
              title="Ask about the whole app instead"
              disabled={Boolean(asking)}
              onClick={() => setFile(null)}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              data-testid="inspector-chat-about-remove"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <Textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds a line (a phone keyboard has no other way to); Ctrl or Cmd with Enter sends.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
          rows={2}
          maxLength={INSPECTOR_CHAT_MAX_MESSAGE}
          disabled={Boolean(asking)}
          placeholder={file ? "Ask about this file" : "Ask about this app"}
          aria-label="Your question"
          className="max-h-40 min-h-16 resize-none"
          data-testid="inspector-chat-input"
        />
        <div className="flex items-center gap-2">
          {onAskAgent ? (
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={onAskAgent} data-testid="inspector-chat-agent">
              <Bot /> Ask an agent instead
            </Button>
          ) : null}
          <span className="flex-1" />
          {/*
            Keys keep these two apart in the page. Without them React turns the Stop button into the
            Send button while the tap on Stop is still being handled, and the browser then submits
            the form: the question that was just stopped went out again.
          */}
          {asking ? (
            <Button key="stop" type="button" variant="outline" size="sm" onClick={stop} data-testid="inspector-chat-stop">
              <CircleStop /> Stop
            </Button>
          ) : (
            <Button key="send" type="submit" size="sm" disabled={!model || !draft.trim()} data-testid="inspector-chat-send">
              <Send /> Send
            </Button>
          )}
        </div>
      </form>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent
          side="bottom"
          className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-xl md:-translate-x-1/2"
          data-testid="inspector-chat-models"
          // No SheetTrigger, so focus is sent back to the button by hand.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            menuButtonRef.current?.focus();
          }}
        >
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
          <SheetHeader className="gap-1 px-4 pt-3 pb-2">
            <SheetTitle className="text-base">Model for this chat</SheetTitle>
            <SheetDescription className="text-xs">The free models need no key. The model you pick is the one that is asked: Automa never switches it for you.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border px-4 pt-3 pb-5">
            {/* A div, not a list: a radiogroup's children must be radios. */}
            <div
              className="flex flex-col divide-y divide-border rounded-lg border border-border"
              role="radiogroup"
              aria-label="Model"
              // Arrows pick a model and keep the sheet open; a tap or Enter picks it and closes the sheet.
              onKeyDown={(event) => handleRadioGroupKeyDown(event, (index) => pickModel(options[index]!))}
            >
              {options.map((id, index) => {
                const selected = id === model;
                const own = id === INSPECTOR_CHAT_CLAUDE;
                const answering = own || freeModelAnswering(health.data?.[resolveFreeModel(id).puterModel]);
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={radioTabIndex(selected, index, model !== null && options.includes(model))}
                    onClick={() => {
                      haptic("tick");
                      pickModel(id);
                      setMenuOpen(false);
                    }}
                    className="flex min-h-12 w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-accent/40"
                    data-model-id={id}
                  >
                    <ChatModelLogo model={id} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{own ? "Claude (your key)" : chatModelName(id)}</span>
                      <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                        {own ? (
                          <>
                            <KeyRound className="size-3 shrink-0" aria-hidden="true" /> Uses your Anthropic API key
                          </>
                        ) : answering ? (
                          "Free, no key needed"
                        ) : (
                          "Did not answer when it was last asked"
                        )}
                      </span>
                    </span>
                    {selected ? <Check className="size-4 shrink-0" aria-label="Selected" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
