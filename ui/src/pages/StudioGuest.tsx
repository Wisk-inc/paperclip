import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CodeXml, Eye, FolderTree, Globe, GitPullRequest, LoaderCircle, LogIn, MessageSquare, Send, SquareTerminal, Undo2 } from "lucide-react";
import type {
  StudioChangeRequest,
  StudioConsoleLine,
  StudioFileNode,
  StudioMessage,
  StudioParticipant,
  StudioRunState,
  StudioServerEvent,
} from "@paperclipai/shared";
import { studioGuestApi, studioSocketUrl, type StudioGuestSession } from "../api/studio";
import { ApiError } from "../api/client";
import { useStudioSocket } from "../hooks/useStudioSocket";
import { useNarrowScreen } from "../hooks/useNarrowScreen";
import { haptic } from "../lib/haptics";
import { cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CodeEditor } from "../components/studio/CodeEditor";
import { StudioFileTree } from "../components/studio/StudioFileTree";
import { StudioConsole } from "../components/studio/StudioConsole";
import { createStudioConsoleStore } from "../components/studio/console-store";
import { StudioPreview } from "../components/studio/StudioPreview";
import { StudioChat } from "../components/studio/StudioChat";
import { StudioDiffView } from "../components/studio/StudioDiffView";
import { Mascot } from "../components/mascot/Mascot";
import { AutomaCredit } from "../components/account/AutomaCredit";

const SESSION_KEY = "automa.studio.guest";
const DRAFT_INTERVAL_MS = 150;

type Pane = "files" | "code" | "console" | "preview" | "chat" | "changes";

function readSession(): StudioGuestSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StudioGuestSession) : null;
  } catch {
    return null;
  }
}

function writeSession(session: StudioGuestSession | null) {
  try {
    if (session) window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // storage unavailable: the session lasts for this page only
  }
}

/** Adds proposed new files to the tree so they can be opened like the rest. */
function withProposedFiles(tree: StudioFileNode[], paths: string[]): StudioFileNode[] {
  const clone = (nodes: StudioFileNode[]): StudioFileNode[] => nodes.map((node) => (node.children ? { ...node, children: clone(node.children) } : { ...node }));
  const root = clone(tree);
  for (const path of paths) {
    const parts = path.split("/");
    let level = root;
    parts.forEach((part, index) => {
      const nodePath = parts.slice(0, index + 1).join("/");
      const isFile = index === parts.length - 1;
      let node = level.find((item) => item.name === part);
      if (!node) {
        node = isFile ? { name: part, path: nodePath, type: "file" } : { name: part, path: nodePath, type: "folder", children: [] };
        level.push(node);
      }
      if (!isFile) level = node.children ?? (node.children = []);
    });
  }
  return root;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

/** The page a collaborator opens from an invite: join with a code, then build together. */
export function StudioGuest() {
  const [session, setSession] = useState<StudioGuestSession | null>(() => readSession());
  const [ended, setEnded] = useState<string | null>(null);

  if (ended) {
    return (
      <GuestFrame>
        <div className="flex flex-col items-center gap-4 text-center">
          <Mascot pose="confused" size="md" />
          <h1 className="text-lg font-semibold">You left the project</h1>
          <p className="max-w-sm text-sm text-muted-foreground">{ended}</p>
          <Button
            onClick={() => {
              setEnded(null);
              setSession(null);
            }}
          >
            Join with a code
          </Button>
        </div>
      </GuestFrame>
    );
  }
  if (!session) {
    return (
      <JoinForm
        onJoined={(joined) => {
          writeSession(joined);
          setSession(joined);
        }}
      />
    );
  }
  return (
    <GuestWorkspace
      session={session}
      onEnded={(reason) => {
        writeSession(null);
        setEnded(reason);
      }}
    />
  );
}

function GuestFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background p-4 pt-(--sz-safe-top) pb-(--sz-safe-bottom) text-foreground">
      <div className="w-full max-w-sm">{children}</div>
      <p className="mt-8 text-center text-xs text-muted-foreground" data-testid="studio-guest-credit">
        <span className="whitespace-nowrap">Automa App Studio ·</span> <AutomaCredit />
      </p>
    </div>
  );
}

function JoinForm({ onJoined }: { onJoined: (session: StudioGuestSession) => void }) {
  const initialCode = useMemo(() => new URLSearchParams(window.location.search).get("code") ?? "", []);
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || !name.trim()) return setError("Enter the code and your name.");
    setBusy(true);
    setError(null);
    try {
      const joined = await studioGuestApi.join(code.trim(), name.trim());
      haptic("success");
      onJoined(joined);
    } catch (joinError) {
      haptic("warning");
      setError(joinError instanceof ApiError && joinError.status === 404 ? "That code doesn't match a shared project." : errorText(joinError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <GuestFrame>
      <form onSubmit={submit} className="flex flex-col items-center gap-4 text-center" data-testid="studio-guest-join">
        <Mascot pose="excited" size="md" gaze="down" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Join a project</h1>
          <p className="text-sm text-muted-foreground">Build, debug, and chat together in real time.</p>
        </div>
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="Join code"
          aria-label="Join code"
          autoCapitalize="characters"
          autoCorrect="off"
          className="h-12 text-center font-mono text-xl tracking-widest"
          maxLength={20}
        />
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" aria-label="Your name" className="h-11" maxLength={40} />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" /> : <LogIn />} Join
        </Button>
      </form>
    </GuestFrame>
  );
}

interface OpenGuestFile {
  path: string;
  /** Saved on the owner's server (null for a file you are proposing). */
  saved: string | null;
  binary: boolean;
}

function GuestWorkspace({ session, onEnded }: { session: StudioGuestSession; onEnded: (reason: string) => void }) {
  const token = session.token;
  const narrow = useNarrowScreen();
  const [pane, setPane] = useState<Pane>("code");
  const [sideTab, setSideTab] = useState<Exclude<Pane, "files" | "code">>("chat");
  const [tree, setTree] = useState<StudioFileNode[]>([]);
  const [participants, setParticipants] = useState<StudioParticipant[]>([]);
  const [me, setMe] = useState<StudioParticipant | null>(null);
  const [run, setRun] = useState<StudioRunState | null>(null);
  const consoleStore = useMemo(() => createStudioConsoleStore(), [token]);
  const [messages, setMessages] = useState<StudioMessage[]>([]);
  const [changes, setChanges] = useState<StudioChangeRequest[]>([]);
  const [file, setFile] = useState<OpenGuestFile | null>(null);
  /** Your proposed edits, by path. */
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** What others are typing, by `participantId:path`. */
  const [drafts, setDrafts] = useState<Record<string, { path: string; text: string; by: StudioParticipant }>>({});
  const [submitOpen, setSubmitOpen] = useState(false);
  const fileRef = useRef<OpenGuestFile | null>(null);
  fileRef.current = file;
  const lastDraftAt = useRef(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAuthError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) onEnded("Your invite ended. Ask the owner for a new code.");
    },
    [onEnded],
  );

  const refreshTree = useCallback(() => {
    void studioGuestApi.tree(token).then((result) => setTree(result.tree)).catch(handleAuthError);
  }, [handleAuthError, token]);

  useEffect(() => {
    void studioGuestApi
      .workspace(token)
      .then((result) => {
        setParticipants(result.participants);
        setMe(result.you);
        setRun(result.run);
      })
      .catch(handleAuthError);
    refreshTree();
    void studioGuestApi.console(token).then((result) => consoleStore.merge(result.lines)).catch(() => undefined);
    void studioGuestApi.messages(token).then((result) => setMessages(result.messages)).catch(() => undefined);
    void studioGuestApi.changes(token).then((result) => setChanges(result.changeRequests)).catch(() => undefined);
  }, [handleAuthError, refreshTree, token]);

  const openFile = useCallback(
    async (path: string) => {
      try {
        if (path in edits && !(await studioGuestApi.readFile(token, path).catch(() => null))) {
          setFile({ path, saved: null, binary: false });
        } else {
          const loaded = await studioGuestApi.readFile(token, path);
          setFile({ path: loaded.path, saved: loaded.content, binary: loaded.content === null });
        }
        setPane("code");
      } catch (error) {
        handleAuthError(error);
      }
    },
    [edits, handleAuthError, token],
  );

  const handleEvent = useCallback(
    (event: StudioServerEvent) => {
      switch (event.type) {
        case "hello":
          setMe(event.you);
          setParticipants(event.participants);
          break;
        case "presence":
          setParticipants(event.participants);
          break;
        case "tree:changed":
          refreshTree();
          break;
        case "file:saved":
          if (fileRef.current?.path === event.path) {
            if (event.version === "deleted") setFile((current) => (current ? { ...current, saved: null } : current));
            else if (event.content !== null) setFile((current) => (current ? { ...current, saved: event.content } : current));
            else void openFile(event.path);
          }
          break;
        case "draft":
          setDrafts((current) => ({ ...current, [`${event.by.id}:${event.path}`]: { path: event.path, text: event.text, by: event.by } }));
          break;
        case "draft:clear":
          setDrafts((current) => {
            const next = { ...current };
            delete next[`${event.byId}:${event.path}`];
            return next;
          });
          break;
        case "chat":
          setMessages((current) => (current.some((message) => message.id === event.message.id) ? current : [...current, event.message]));
          break;
        case "change:new":
        case "change:resolved":
          if (event.changeRequest.collaboratorId === session.collaborator.id) {
            setChanges((current) => {
              const exists = current.some((change) => change.id === event.changeRequest.id);
              return exists ? current.map((change) => (change.id === event.changeRequest.id ? event.changeRequest : change)) : [event.changeRequest, ...current];
            });
            if (event.type === "change:resolved") haptic(event.changeRequest.status === "accepted" ? "success" : "warning");
          }
          break;
        case "console":
          consoleStore.push(event.lines);
          break;
        case "console:clear":
          consoleStore.clear();
          break;
        case "run":
          setRun(event.state);
          break;
        case "kicked":
          onEnded(event.reason);
          break;
        default:
          break;
      }
    },
    [onEnded, openFile, refreshTree, session.collaborator.id],
  );
  const socketUrl = useMemo(() => studioSocketUrl({ guestToken: token }), [token]);
  const { status: socketStatus, send } = useStudioSocket(socketUrl, handleEvent);

  useEffect(() => {
    send({ type: "focus", path: file?.path ?? null });
  }, [file?.path, send, socketStatus]);

  // What you see: your edit, else the owner's live typing, else the saved file.
  const ownerDraft = file ? Object.values(drafts).find((draft) => draft.path === file.path && draft.by.role === "owner") ?? null : null;
  const otherDrafts = file ? Object.values(drafts).filter((draft) => draft.path === file.path && draft.by.id !== me?.id) : [];
  const myEdit = file ? edits[file.path] : undefined;
  const shownText = myEdit ?? ownerDraft?.text ?? file?.saved ?? "";
  const following = myEdit === undefined && Boolean(ownerDraft);

  const onEdit = (value: string) => {
    const current = fileRef.current;
    if (!current) return;
    setEdits((all) => ({ ...all, [current.path]: value }));
    const sendDraft = () => {
      lastDraftAt.current = Date.now();
      send({ type: "draft", path: current.path, text: value });
    };
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (Date.now() - lastDraftAt.current >= DRAFT_INTERVAL_MS) sendDraft();
    else draftTimer.current = setTimeout(sendDraft, DRAFT_INTERVAL_MS);
  };

  const discardEdit = (path: string) => {
    setEdits((all) => {
      const next = { ...all };
      delete next[path];
      return next;
    });
    send({ type: "draft:clear", path });
  };

  const proposedNew = Object.keys(edits).filter((path) => !treeHas(tree, path));
  const shownTree = useMemo(() => withProposedFiles(tree, proposedNew), [tree, proposedNew.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const editCount = Object.keys(edits).length;

  const treePane = (
    <StudioFileTree
      tree={shownTree}
      activePath={file?.path ?? null}
      onOpen={(path) => void openFile(path)}
      editedPaths={new Set(Object.keys(edits))}
      participants={participants.filter((participant) => participant.id !== me?.id)}
      archiveUrl={(path) => studioGuestApi.archiveUrl(token, path)}
      onCreate={(path, type) => {
        if (type === "folder") return;
        setEdits((all) => ({ ...all, [path]: "" }));
        setFile({ path, saved: null, binary: false });
        setPane("code");
      }}
    />
  );

  const editorPane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-9 items-center gap-2 border-b border-border px-3 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file?.path ?? "No file open"}</span>
        {file && myEdit !== undefined ? (
          <Button size="xs" variant="ghost" onClick={() => discardEdit(file.path)}>
            <Undo2 /> Discard my edits
          </Button>
        ) : null}
      </div>
      {file && (following || otherDrafts.length) ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground" data-testid="studio-live-typing">
          {otherDrafts.map((draft) => (
            <span key={draft.by.id} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ backgroundColor: draft.by.color }} />
              {draft.by.name} is typing
            </span>
          ))}
          {following ? (
            <span className="flex items-center gap-1">
              <Eye className="size-3" /> Showing their live edits. Type to make your own.
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {file?.binary ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{file.path} isn't a text file.</p>
        ) : file ? (
          <CodeEditor key={file.path} path={file.path} value={shownText} onChange={onEdit} />
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Pick a file to see it. Your edits become a change the owner reviews.</p>
        )}
      </div>
    </div>
  );

  const myChanges = (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {changes.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Edit a file, then tap Submit. The owner sees your changes in red and green and accepts or denies them.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {changes.map((change) => (
            <li key={change.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
              <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{change.files.map((item) => item.path).join(", ")}</p>
                <p className="text-xs text-muted-foreground">{timeAgo(change.createdAt)}</p>
              </div>
              <span
                className={cn(
                  "text-xs font-medium",
                  change.status === "accepted" ? "text-studio-diff-add-mark" : change.status === "rejected" ? "text-studio-diff-del-mark" : "text-muted-foreground",
                )}
                data-testid="studio-guest-change-status"
              >
                {change.status === "open" ? "Waiting for review" : change.status === "accepted" ? "Accepted" : "Denied"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const sidePanes = {
    console: <StudioConsole store={consoleStore} run={run} />,
    preview: <StudioPreview run={run} consoleApp={false} consoleStore={consoleStore} onShowConsole={() => setPane("console")} />,
    chat: (
      <StudioChat
        messages={messages}
        me={{ type: "guest", collaboratorId: session.collaborator.id }}
        onSend={async (body, attachment) => {
          const result = await studioGuestApi.postMessage(token, body, attachment);
          setMessages((current) => (current.some((message) => message.id === result.message.id) ? current : [...current, result.message]));
        }}
        fileUrl={(attachmentId) => studioGuestApi.sharedFileUrl(token, attachmentId)}
      />
    ),
    changes: <div className="flex h-full min-h-0 flex-col">{myChanges}</div>,
  };
  const tabs: Array<{ id: Pane; label: string; icon: typeof CodeXml; badge?: boolean }> = [
    { id: "files", label: "Files", icon: FolderTree },
    { id: "code", label: "Code", icon: CodeXml },
    { id: "console", label: "Console", icon: SquareTerminal, badge: run?.status === "running" },
    { id: "preview", label: "Preview", icon: Globe, badge: Boolean(run?.previewReady) },
    { id: "chat", label: "Chat", icon: MessageSquare },
    { id: "changes", label: "Changes", icon: GitPullRequest, badge: changes.some((change) => change.status === "open") },
  ];

  return (
    <div className="flex h-dvh flex-col bg-background pt-(--sz-safe-top) pb-(--sz-safe-bottom) text-foreground" data-testid="studio-guest">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{session.workspace.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            You're {session.collaborator.displayName}
            {socketStatus !== "open" ? " · reconnecting…" : ""}
          </p>
        </div>
        <div className="flex -space-x-1.5" aria-label="People here">
          {participants.slice(0, 5).map((participant) => (
            <span
              key={participant.id}
              title={participant.name}
              className="flex size-7 items-center justify-center rounded-full text-xs font-semibold text-studio-badge-foreground ring-2 ring-background"
              style={{ backgroundColor: participant.color }}
            >
              {participant.name.charAt(0).toUpperCase()}
            </span>
          ))}
        </div>
        <Button size="sm" disabled={editCount === 0} onClick={() => setSubmitOpen(true)} data-testid="studio-guest-submit">
          <Send /> Submit{editCount ? ` (${editCount})` : ""}
        </Button>
      </header>

      {narrow ? (
      <>
      <div className="min-h-0 flex-1">{pane === "files" ? treePane : pane === "code" ? editorPane : sidePanes[pane]}</div>
      <div className="flex border-t border-border bg-card" role="tablist" aria-label="Project panes">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={pane === tab.id}
              onClick={() => setPane(tab.id)}
              className={cn("relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-(length:--text-micro)", pane === tab.id ? "font-semibold text-primary" : "text-muted-foreground")}
              data-testid={`studio-tab-${tab.id}`}
            >
              <Icon className="size-4" />
              {tab.label}
              {tab.badge ? <span className="absolute top-1 right-1/4 size-1.5 rounded-full bg-primary" /> : null}
              {pane === tab.id ? <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary" /> : null}
            </button>
          );
        })}
      </div>

      </>
      ) : (
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r border-border">{treePane}</aside>
        <section className="min-w-0 flex-1">{editorPane}</section>
        <aside className="flex w-96 shrink-0 flex-col border-l border-border">
          <div className="flex border-b border-border" role="tablist" aria-label="Side panel">
            {tabs
              .filter((tab): tab is (typeof tabs)[number] & { id: keyof typeof sidePanes } => tab.id !== "files" && tab.id !== "code")
              .map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={sideTab === tab.id}
                  onClick={() => setSideTab(tab.id)}
                  className={cn("relative flex-1 py-2 text-sm", sideTab === tab.id ? "font-medium" : "text-muted-foreground")}
                >
                  {tab.label}
                  {sideTab === tab.id ? <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-foreground" /> : null}
                </button>
              ))}
          </div>
          <div className="min-h-0 flex-1">{sidePanes[sideTab]}</div>
        </aside>
      </div>
      )}

      <SubmitDialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        token={token}
        edits={edits}
        onSubmitted={(change) => {
          setChanges((current) => [change, ...current.filter((item) => item.id !== change.id)]);
          for (const path of Object.keys(edits)) send({ type: "draft:clear", path });
          setEdits({});
          setPane("changes");
          setSideTab("changes");
        }}
      />
    </div>
  );
}

function treeHas(nodes: StudioFileNode[], path: string): boolean {
  for (const node of nodes) {
    if (node.path === path) return true;
    if (node.children && path.startsWith(`${node.path}/`) && treeHas(node.children, path)) return true;
  }
  return false;
}

function SubmitDialog({
  open,
  onOpenChange,
  token,
  edits,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  edits: Record<string, string>;
  onSubmitted: (change: StudioChangeRequest) => void;
}) {
  const [message, setMessage] = useState("");
  const [before, setBefore] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Show the change against the file as it is now.
  useEffect(() => {
    if (!open) return;
    setError(null);
    let cancelled = false;
    void Promise.all(
      Object.keys(edits).map(async (path) => {
        const current = await studioGuestApi.readFile(token, path).catch(() => null);
        return [path, current?.content ?? null] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setBefore(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [edits, open, token]);

  const files = Object.entries(edits).map(([path, after]) => ({ path, before: before[path] ?? null, after }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await studioGuestApi.submitChange(token, { message: message.trim() || null, files: files.map(({ path, after }) => ({ path, after })) });
      haptic("success");
      setMessage("");
      onOpenChange(false);
      onSubmitted(result.changeRequest);
    } catch (submitError) {
      setError(errorText(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send your changes</DialogTitle>
          <DialogDescription>The owner reviews them, red for what you removed and green for what you added, then accepts or denies.</DialogDescription>
        </DialogHeader>
        <Textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={2} placeholder="What did you change? (optional)" aria-label="Describe your changes" />
        <StudioDiffView files={files} />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="flex-row justify-between sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep editing
          </Button>
          <Button disabled={busy || files.length === 0} onClick={() => void submit()} data-testid="studio-guest-send-changes">
            {busy ? <LoaderCircle className="animate-spin" /> : <Send />} Submit for review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
