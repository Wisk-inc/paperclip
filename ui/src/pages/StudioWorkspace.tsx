import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CircleStop,
  CodeXml,
  Eye,
  FolderTree,
  Globe,
  LoaderCircle,
  Play,
  Settings2,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Users,
} from "lucide-react";
import type {
  StudioAssistantTurn,
  StudioChangeRequest,
  StudioConsoleLine,
  StudioMessage,
  StudioParticipant,
  StudioRunState,
  StudioServerEvent,
} from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { studioApi, studioSocketUrl, type StudioShareResult } from "../api/studio";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useStudioSocket } from "../hooks/useStudioSocket";
import { useNarrowScreen } from "../hooks/useNarrowScreen";
import { useUndoableAction } from "../hooks/useUndoableAction";
import { haptic } from "../lib/haptics";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageSkeleton } from "../components/PageSkeleton";
import { Mascot } from "../components/mascot/Mascot";
import { AppearancePicker } from "../components/AppearancePicker";
import { CodeEditor } from "../components/studio/CodeEditor";
import { StudioFileTree } from "../components/studio/StudioFileTree";
import { StudioConsole } from "../components/studio/StudioConsole";
import { StudioPreview } from "../components/studio/StudioPreview";
import { StudioAssistant } from "../components/studio/StudioAssistant";
import { StudioTeamPanel } from "../components/studio/StudioTeamPanel";
import { LanguageLogo } from "../components/studio/LanguageLogo";

type Pane = "files" | "code" | "console" | "preview" | "ai" | "team";
type SideTab = Exclude<Pane, "files" | "code">;

interface OpenFile {
  path: string;
  /** What the editor shows (your edits). */
  content: string;
  /** What is saved on the server. */
  savedContent: string;
  version: string;
  binary: boolean;
  size: number;
}

type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

interface RemoteDraft {
  path: string;
  text: string;
  by: StudioParticipant;
}

const SAVE_DELAY_MS = 800;
const DRAFT_INTERVAL_MS = 150;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

function mergeLines(current: StudioConsoleLine[], incoming: StudioConsoleLine[]) {
  if (!incoming.length) return current;
  const last = current.at(-1)?.seq ?? 0;
  const fresh = incoming.filter((line) => line.seq > last);
  if (!fresh.length) return current;
  return [...current, ...fresh].slice(-2000);
}

function upsertTurn(turns: StudioAssistantTurn[], turn: StudioAssistantTurn) {
  const index = turns.findIndex((item) => item.id === turn.id);
  if (index === -1) return [...turns, turn];
  const next = [...turns];
  next[index] = turn;
  return next;
}

/**
 * A Studio project, like a small Replit: files on the left, the editor in
 * the middle, and the console, preview, AI assistant, and team on the right.
 * On a phone each of those is a tab. Edits save on their own and everyone in
 * the project sees them as they are typed.
 */
export function StudioWorkspace() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const narrow = useNarrowScreen();

  const [pane, setPane] = useState<Pane>("code");
  const [sideTab, setSideTab] = useState<SideTab>("console");
  const [run, setRun] = useState<StudioRunState | null>(null);
  const [consoleLines, setConsoleLines] = useState<StudioConsoleLine[]>([]);
  const [participants, setParticipants] = useState<StudioParticipant[]>([]);
  const [me, setMe] = useState<StudioParticipant | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RemoteDraft>>({});
  const [watching, setWatching] = useState<string | null>(null);
  const [turns, setTurns] = useState<StudioAssistantTurn[]>([]);
  const [assistantRunning, setAssistantRunning] = useState(false);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [share, setShare] = useState<StudioShareResult | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState<"run" | "stop" | "install" | null>(null);
  const [initialPrompt, setInitialPrompt] = useState<string | null>(() => {
    const state = location.state as { prompt?: string } | null;
    return state?.prompt ?? null;
  });

  const fileRef = useRef<OpenFile | null>(null);
  fileRef.current = file;
  const teamVisibleRef = useRef(false);
  teamVisibleRef.current = narrow ? pane === "team" : sideTab === "team";
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDraftAt = useRef(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Data ──────────────────────────────────────────────────────────────
  const detail = useQuery({
    queryKey: queryKeys.studio.detail(workspaceId),
    queryFn: () => studioApi.get(workspaceId),
    enabled: !!workspaceId,
  });
  const workspace = detail.data?.workspace ?? null;
  const catalog = useQuery({
    queryKey: queryKeys.studio.catalog(companyId),
    queryFn: () => studioApi.catalog(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });
  const tree = useQuery({ queryKey: queryKeys.studio.tree(workspaceId), queryFn: () => studioApi.tree(workspaceId), enabled: !!workspaceId });
  const messages = useQuery({ queryKey: queryKeys.studio.messages(workspaceId), queryFn: () => studioApi.messages(workspaceId), enabled: !!workspaceId });
  const changes = useQuery({ queryKey: queryKeys.studio.changes(workspaceId), queryFn: () => studioApi.changes(workspaceId), enabled: !!workspaceId });
  const collaborators = useQuery({
    queryKey: queryKeys.studio.collaborators(workspaceId),
    queryFn: () => studioApi.collaborators(workspaceId),
    enabled: !!workspaceId,
  });
  const aiKeys = useQuery({ queryKey: queryKeys.studio.aiKeys(companyId), queryFn: () => studioApi.aiKeys(companyId), enabled: !!selectedCompanyId });
  const assistant = useQuery({
    queryKey: queryKeys.studio.assistant(workspaceId),
    queryFn: () => studioApi.assistant(workspaceId),
    enabled: !!workspaceId,
    refetchInterval: assistantRunning ? 4000 : false,
  });

  const language = useMemo(() => catalog.data?.languages.find((item) => item.id === workspace?.language) ?? null, [catalog.data, workspace?.language]);
  const consoleApp = language?.kind === "cli";

  useEffect(() => {
    if (detail.data) {
      setRun(detail.data.run);
      setAssistantRunning(detail.data.assistantRunning);
      setParticipants((current) => (current.length ? current : detail.data!.participants));
    }
  }, [detail.data]);

  useEffect(() => {
    if (assistant.data) {
      setTurns(assistant.data.turns);
      setAssistantRunning(assistant.data.running);
    }
  }, [assistant.data]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void studioApi.console(workspaceId).then((result) => {
      if (!cancelled) setConsoleLines((current) => mergeLines(current, result.lines));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    setBreadcrumbs([{ label: "App Studio", href: "/studio" }, { label: workspace?.name ?? "App" }]);
  }, [setBreadcrumbs, workspace?.name]);

  // A description from "New app" goes to the assistant.
  useEffect(() => {
    if (!initialPrompt) return;
    setPane("ai");
    setSideTab("ai");
  }, [initialPrompt]);

  // ── Live socket ───────────────────────────────────────────────────────
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
          void queryClient.invalidateQueries({ queryKey: queryKeys.studio.tree(workspaceId) });
          break;
        case "file:saved": {
          const current = fileRef.current;
          if (!current || current.path !== event.path) break;
          if (event.version === "deleted") {
            pushToast({ title: `${event.path} was deleted`, tone: "info" });
            setFile(null);
            break;
          }
          if (event.content !== null && event.content === current.content) {
            setFile({ ...current, savedContent: event.content, version: event.version });
            break;
          }
          if (current.content === current.savedContent) {
            if (event.content !== null) setFile({ ...current, content: event.content, savedContent: event.content, version: event.version });
            else void studioApi.readFile(workspaceId, current.path).then((loaded) => setFile({ ...current, content: loaded.content ?? "", savedContent: loaded.content ?? "", version: loaded.version }));
          } else {
            setSaveState("conflict");
          }
          break;
        }
        case "draft":
          setDrafts((current) => ({ ...current, [`${event.by.id}:${event.path}`]: { path: event.path, text: event.text, by: event.by } }));
          break;
        case "draft:clear":
          setDrafts((current) => {
            const key = `${event.byId}:${event.path}`;
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
          break;
        case "chat":
          queryClient.setQueryData<{ messages: StudioMessage[] }>(queryKeys.studio.messages(workspaceId), (current) =>
            current?.messages.some((message) => message.id === event.message.id)
              ? current
              : { messages: [...(current?.messages ?? []), event.message] },
          );
          break;
        case "change:new":
        case "change:resolved":
          queryClient.setQueryData<{ changeRequests: StudioChangeRequest[] }>(queryKeys.studio.changes(workspaceId), (current) => {
            const list = current?.changeRequests ?? [];
            const exists = list.some((change) => change.id === event.changeRequest.id);
            return { changeRequests: exists ? list.map((change) => (change.id === event.changeRequest.id ? event.changeRequest : change)) : [event.changeRequest, ...list] };
          });
          if (event.type === "change:new") {
            haptic("tick");
            // The Team pane already shows it; toast only from elsewhere.
            if (!teamVisibleRef.current) pushToast({ title: `${event.changeRequest.authorName} sent changes to review`, tone: "info" });
          }
          break;
        case "console":
          setConsoleLines((current) => mergeLines(current, event.lines));
          break;
        case "run":
          setRun(event.state);
          break;
        case "assistant":
          setTurns((current) => upsertTurn(current, event.turn));
          if (event.turn.role === "assistant") setAssistantRunning(!event.done);
          break;
        case "share":
          void queryClient.invalidateQueries({ queryKey: queryKeys.studio.detail(workspaceId) });
          break;
        default:
          break;
      }
    },
    [pushToast, queryClient, workspaceId],
  );
  const socketUrl = useMemo(() => (workspaceId ? studioSocketUrl({ workspaceId }) : null), [workspaceId]);
  const { status: socketStatus, send } = useStudioSocket(socketUrl, handleEvent);

  // ── Files ─────────────────────────────────────────────────────────────
  const save = useCallback(
    async (options: { force?: boolean } = {}) => {
      const current = fileRef.current;
      if (!current || current.binary || current.content === current.savedContent) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const content = current.content;
      setSaveState("saving");
      try {
        const saved = await studioApi.writeFile(workspaceId, { path: current.path, content, baseVersion: options.force ? null : current.version });
        const latest = fileRef.current;
        if (latest && latest.path === saved.path) {
          setFile({ ...latest, savedContent: content, version: saved.version });
          setSaveState(latest.content === content ? "saved" : "dirty");
        }
        send({ type: "draft:clear", path: current.path });
      } catch (error) {
        setSaveState(error instanceof ApiError && error.status === 409 ? "conflict" : "error");
      }
    },
    [send, workspaceId],
  );

  const openFile = useCallback(
    async (path: string, options: { show?: boolean } = {}) => {
      const current = fileRef.current;
      if (current && current.content !== current.savedContent) await save();
      setWatching(null);
      setFileLoading(true);
      try {
        const loaded = await studioApi.readFile(workspaceId, path);
        setFile({ path: loaded.path, content: loaded.content ?? "", savedContent: loaded.content ?? "", version: loaded.version, binary: loaded.content === null, size: loaded.size });
        setSaveState("saved");
        send({ type: "focus", path: loaded.path });
        if (options.show !== false) setPane("code");
      } catch (error) {
        pushToast({ title: `Couldn't open ${path}`, body: errorText(error), tone: "error" });
      } finally {
        setFileLoading(false);
      }
    },
    [pushToast, save, send, workspaceId],
  );

  // Open the entry file (or the first file) once the tree arrives.
  const openedFirst = useRef(false);
  useEffect(() => {
    if (openedFirst.current || !tree.data || !workspace) return;
    openedFirst.current = true;
    const paths: string[] = [];
    const walk = (nodes: typeof tree.data.tree) => {
      for (const node of nodes) {
        if (node.type === "file") paths.push(node.path);
        else walk(node.children ?? []);
      }
    };
    walk(tree.data.tree);
    const entry = language?.entry && paths.includes(language.entry) ? language.entry : paths.find((path) => /(^|\/)(index\.html|main\.\w+|app\.\w+|server\.\w+|README\.md)$/i.test(path)) ?? paths[0];
    if (entry) void openFile(entry, { show: false });
  }, [tree.data, workspace, language, openFile]);

  const onEdit = (value: string) => {
    const current = fileRef.current;
    if (!current) return;
    setFile({ ...current, content: value });
    setSaveState(value === current.savedContent ? "saved" : "dirty");
    // Everyone else sees the typing live.
    const now = Date.now();
    const sendDraft = () => {
      lastDraftAt.current = Date.now();
      send({ type: "draft", path: current.path, text: fileRef.current?.content ?? value });
    };
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (now - lastDraftAt.current >= DRAFT_INTERVAL_MS) sendDraft();
    else draftTimer.current = setTimeout(sendDraft, DRAFT_INTERVAL_MS);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (draftTimer.current) clearTimeout(draftTimer.current);
    },
    [],
  );

  const reloadFromServer = async () => {
    const current = fileRef.current;
    if (!current) return;
    const loaded = await studioApi.readFile(workspaceId, current.path);
    setFile({ ...current, content: loaded.content ?? "", savedContent: loaded.content ?? "", version: loaded.version });
    setSaveState("saved");
    send({ type: "draft:clear", path: current.path });
  };

  const deletions = useUndoableAction({
    commit: async (path) => {
      await studioApi.deleteEntry(workspaceId, path);
      if (fileRef.current?.path === path || fileRef.current?.path.startsWith(`${path}/`)) setFile(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.studio.tree(workspaceId) });
    },
  });

  const editedPaths = useMemo(() => {
    const set = new Set<string>();
    if (file && file.content !== file.savedContent) set.add(file.path);
    for (const draft of Object.values(drafts)) set.add(draft.path);
    return set;
  }, [drafts, file]);

  const draftsHere = useMemo(
    () => (file ? Object.values(drafts).filter((draft) => draft.path === file.path && draft.by.id !== me?.id) : []),
    [drafts, file, me?.id],
  );
  const watchedDraft = watching ? draftsHere.find((draft) => draft.by.id === watching) ?? null : null;

  // ── Running ───────────────────────────────────────────────────────────
  const toolchain = detail.data?.toolchain ?? null;
  const missingToolchain = toolchain && !toolchain.available ? toolchain : null;

  const runApp = async () => {
    setBusy("run");
    try {
      await save();
      const result = await studioApi.run(workspaceId);
      // A quick program can finish (and say so over the socket) before this
      // response arrives; keep the newer state.
      setRun((current) => (current && current.startedAt === result.run.startedAt && current.endedAt ? current : result.run));
      haptic("tick");
      setPane(consoleApp ? "console" : "preview");
      setSideTab(consoleApp ? "console" : "preview");
    } catch (error) {
      haptic("warning");
      pushToast({ title: "Couldn't start the app", body: errorText(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const stopApp = async () => {
    setBusy("stop");
    try {
      const result = await studioApi.stop(workspaceId);
      setRun(result.run);
    } finally {
      setBusy(null);
    }
  };

  const installToolchain = async () => {
    setBusy("install");
    setPane("console");
    setSideTab("console");
    try {
      const result = await studioApi.installToolchain(workspaceId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.studio.detail(workspaceId) });
      if (result.toolchain.available) {
        haptic("success");
        pushToast({ title: `${result.toolchain.requires} is ready`, tone: "success" });
      } else {
        pushToast({ title: "Install didn't finish", body: "See the console for what happened.", tone: "error" });
      }
    } catch (error) {
      pushToast({ title: "Couldn't install it here", body: errorText(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const running = run?.status === "running" || run?.status === "starting";

  const updateSettings = useMutation({
    mutationFn: (input: { name?: string; runCommand?: string | null }) => studioApi.update(workspaceId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.studio.detail(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.studio.list(companyId) });
      setSettingsOpen(false);
    },
  });
  const removeWorkspace = useMutation({
    mutationFn: () => studioApi.remove(workspaceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.studio.list(companyId) });
      navigate("/studio");
    },
  });

  if (detail.isLoading && !detail.data) return <PageSkeleton variant="detail" />;
  if (detail.error || !workspace) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-destructive">{detail.error ? errorText(detail.error) : "This app doesn't exist anymore."}</p>
        <Button variant="outline" asChild>
          <Link to="/studio">Back to Studio</Link>
        </Button>
      </div>
    );
  }

  // ── Panes ─────────────────────────────────────────────────────────────
  const openChanges = (changes.data?.changeRequests ?? []).filter((change) => change.status === "open").length;
  const keys = aiKeys.data?.keys ?? [];

  const treePane = (
    <StudioFileTree
      tree={tree.data?.tree ?? []}
      activePath={file?.path ?? null}
      onOpen={(path) => void openFile(path)}
      editedPaths={editedPaths}
      hiddenPaths={deletions.hiddenIds}
      participants={participants.filter((participant) => participant.id !== me?.id)}
      onCreate={async (path, type) => {
        try {
          await studioApi.createEntry(workspaceId, { path, type });
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.tree(workspaceId) });
        } catch (error) {
          pushToast({ title: `Couldn't create ${path}`, body: errorText(error), tone: "error" });
          throw error;
        }
      }}
      onRename={async (from, to) => {
        try {
          if (fileRef.current?.path === from) await save();
          await studioApi.move(workspaceId, { from, to });
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.tree(workspaceId) });
          if (fileRef.current?.path === from) await openFile(to);
        } catch (error) {
          pushToast({ title: "Couldn't rename", body: errorText(error), tone: "error" });
        }
      }}
      onDelete={(path) => deletions.run(path, `Deleted ${path.split("/").pop()}`)}
      onUpload={async (files, folder) => {
        try {
          const result = await studioApi.upload(workspaceId, files, folder);
          haptic("success");
          pushToast({ title: result.paths.length === 1 ? `Added ${result.paths[0]}` : `Added ${result.paths.length} files`, tone: "success" });
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.tree(workspaceId) });
        } catch (error) {
          pushToast({ title: "Upload failed", body: errorText(error), tone: "error" });
        }
      }}
      downloadUrl={(path) => studioApi.downloadUrl(workspaceId, path)}
    />
  );

  const editorPane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-9 items-center gap-2 border-b border-border px-3 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="studio-open-file">
          {file?.path ?? (fileLoading ? "Opening…" : "No file open")}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground" data-testid="studio-save-state">
          {saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Edited" : saveState === "error" ? "Not saved" : saveState === "conflict" ? "Changed elsewhere" : file ? "Saved" : ""}
        </span>
      </div>
      {saveState === "conflict" ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-2 text-sm">
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">This file changed somewhere else while you were editing.</span>
          <Button size="xs" variant="outline" onClick={() => void reloadFromServer()}>
            Load theirs
          </Button>
          <Button size="xs" onClick={() => void save({ force: true })}>
            Keep mine
          </Button>
        </div>
      ) : null}
      {draftsHere.length ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs" data-testid="studio-live-typing">
          {draftsHere.map((draft) => (
            <button
              key={draft.by.id}
              type="button"
              onClick={() => setWatching((current) => (current === draft.by.id ? null : draft.by.id))}
              className={cn("flex items-center gap-1.5 rounded-full border px-2 py-0.5", watching === draft.by.id ? "border-primary text-primary" : "border-border text-muted-foreground")}
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: draft.by.color }} />
              {draft.by.name} is typing here
              <Eye className="size-3" />
              {watching === draft.by.id ? "Back to mine" : "Watch"}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {file && file.binary ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <p>{file.path} isn't a text file.</p>
            <Button variant="outline" size="sm" asChild>
              <a href={studioApi.downloadUrl(workspaceId, file.path)} download>
                Download it
              </a>
            </Button>
          </div>
        ) : file ? (
          watchedDraft ? (
            <CodeEditor key={`watch:${file.path}`} path={file.path} value={watchedDraft.text} readOnly ariaLabel={`${watchedDraft.by.name}'s live edits`} />
          ) : (
            <CodeEditor key={file.path} path={file.path} value={file.content} onChange={onEdit} onSave={() => void save()} />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            {fileLoading ? (
              <LoaderCircle className="size-5 animate-spin" />
            ) : (
              <>
                <Mascot pose="idle" size="sm" gaze="down" />
                Pick a file to edit, or make a new one.
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const consolePane = (
    <div className="flex h-full min-h-0 flex-col">
      {missingToolchain ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-2 text-sm">
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">
            {missingToolchain.requires} isn't installed on this device{missingToolchain.installCommand ? "." : `. ${missingToolchain.note ?? ""}`}
          </span>
          {missingToolchain.installCommand ? (
            <Button size="xs" disabled={busy === "install"} onClick={() => void installToolchain()}>
              {busy === "install" ? <LoaderCircle className="animate-spin" /> : null} Install
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <StudioConsole
          lines={consoleLines}
          run={run}
          onClear={() => {
            setConsoleLines([]);
            void studioApi.clearConsole(workspaceId);
          }}
          onInput={async (text) => {
            await studioApi.consoleInput(workspaceId, text);
          }}
          onExec={async (command) => {
            try {
              await studioApi.exec(workspaceId, command);
            } catch (error) {
              pushToast({ title: "Command failed to start", body: errorText(error), tone: "error" });
            }
          }}
        />
      </div>
    </div>
  );

  const previewPane = (
    <StudioPreview
      run={run}
      consoleApp={consoleApp}
      onRun={() => void runApp()}
      onShowConsole={() => {
        setPane("console");
        setSideTab("console");
      }}
      publicLink={{
        cloudflaredInstalled: Boolean(catalog.data?.cloudflared),
        onOpen: async () => {
          try {
            const result = await studioApi.openPublicLink(workspaceId);
            setRun(result.run);
            haptic("success");
          } catch (error) {
            haptic("warning");
            pushToast({ title: "No public link", body: errorText(error), tone: "error" });
          }
        },
        onClose: async () => {
          const result = await studioApi.closePublicLink(workspaceId);
          setRun(result.run);
        },
        onInstall: async () => {
          const result = await studioApi.installCloudflared(companyId);
          pushToast({ title: result.ok ? "Public links are ready" : "Couldn't set up public links", body: result.message, tone: result.ok ? "success" : "error" });
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.catalog(companyId) });
          await queryClient.refetchQueries({ queryKey: queryKeys.studio.catalog(companyId) });
        },
      }}
    />
  );

  const aiPane = (
    <StudioAssistant
      turns={turns}
      running={assistantRunning}
      keys={keys}
      storageKey={`automa.studio.ai.${companyId}`}
      initialPrompt={initialPrompt}
      onInitialPromptUsed={() => setInitialPrompt(null)}
      onSaveKey={async (provider, apiKey, baseUrl) => {
        await studioApi.saveAiKey(companyId, { provider, apiKey, baseUrl });
        await queryClient.invalidateQueries({ queryKey: queryKeys.studio.aiKeys(companyId) });
      }}
      onRemoveKey={async (provider) => {
        await studioApi.deleteAiKey(companyId, provider);
        await queryClient.invalidateQueries({ queryKey: queryKeys.studio.aiKeys(companyId) });
      }}
      onSend={async (message, provider, model) => {
        await save();
        await studioApi.askAssistant(workspaceId, { message, provider, model });
        setAssistantRunning(true);
      }}
      onStop={async () => {
        await studioApi.stopAssistant(workspaceId);
      }}
      onClear={async () => {
        await studioApi.clearAssistant(workspaceId);
        setTurns([]);
      }}
    />
  );

  const teamPane = (
    <StudioTeamPanel
      shareEnabled={workspace.shareEnabled}
      shareCode={share?.code ?? workspace.shareCode}
      share={share}
      participants={participants}
      collaborators={collaborators.data?.collaborators ?? []}
      messages={messages.data?.messages ?? []}
      changeRequests={changes.data?.changeRequests ?? []}
      onShare={async () => {
        try {
          const result = await studioApi.share(workspaceId);
          setShare(result);
          haptic("success");
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.detail(workspaceId) });
        } catch (error) {
          pushToast({ title: "Couldn't start sharing", body: errorText(error), tone: "error" });
        }
      }}
      onStopSharing={async () => {
        await studioApi.stopSharing(workspaceId);
        setShare(null);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.studio.detail(workspaceId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.studio.collaborators(workspaceId) }),
        ]);
      }}
      onRemoveCollaborator={async (collaboratorId) => {
        await studioApi.removeCollaborator(workspaceId, collaboratorId);
        await queryClient.invalidateQueries({ queryKey: queryKeys.studio.collaborators(workspaceId) });
      }}
      onSendMessage={async (body, attachment) => {
        const result = await studioApi.postMessage(workspaceId, body, attachment);
        queryClient.setQueryData<{ messages: StudioMessage[] }>(queryKeys.studio.messages(workspaceId), (current) =>
          current?.messages.some((message) => message.id === result.message.id) ? current : { messages: [...(current?.messages ?? []), result.message] },
        );
      }}
      fileUrl={(attachmentId) => studioApi.sharedFileUrl(workspaceId, attachmentId)}
      onAddToProject={async (attachmentId) => {
        const result = await studioApi.addSharedFile(workspaceId, attachmentId);
        haptic("success");
        pushToast({ title: `Added ${result.path} to the project`, tone: "success" });
      }}
      onAccept={async (changeId, files) => {
        try {
          await studioApi.acceptChange(workspaceId, changeId, files);
          haptic("success");
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.changes(workspaceId) });
          if (fileRef.current) await reloadFromServer();
        } catch (error) {
          pushToast({ title: "Couldn't accept the change", body: errorText(error), tone: "error" });
        }
      }}
      onReject={async (changeId) => {
        await studioApi.rejectChange(workspaceId, changeId);
        await queryClient.invalidateQueries({ queryKey: queryKeys.studio.changes(workspaceId) });
      }}
    />
  );

  const sidePanes: Record<SideTab, React.ReactNode> = { console: consolePane, preview: previewPane, ai: aiPane, team: teamPane };
  const tabs: Array<{ id: Pane; label: string; icon: typeof CodeXml; badge?: number | boolean }> = [
    { id: "files", label: "Files", icon: FolderTree },
    { id: "code", label: "Code", icon: CodeXml },
    { id: "console", label: "Console", icon: SquareTerminal, badge: running },
    { id: "preview", label: "Preview", icon: Globe, badge: Boolean(run?.previewReady) },
    { id: "ai", label: "AI", icon: Sparkles, badge: assistantRunning },
    { id: "team", label: "Team", icon: Users, badge: openChanges || (participants.length > 1 ? participants.length - 1 : 0) },
  ];

  return (
    <div className="studio-ide flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background md:-m-2" data-testid="studio-workspace">
      {/* Header: the app and its Run button. */}
      <div className="flex items-center gap-2 border-b border-border bg-linear-to-r from-primary/10 to-transparent px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="All apps" asChild>
          <Link to="/studio">
            <ArrowLeft />
          </Link>
        </Button>
        {language ? <LanguageLogo language={language} size="md" /> : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{workspace.name}</p>
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            {running ? (
              <span className="flex items-center gap-1 font-medium text-(--status-agent-running)">
                <span className="size-1.5 animate-pulse rounded-full bg-current" /> Running
              </span>
            ) : run?.status === "failed" ? (
              <span className="font-medium text-destructive">Crashed</span>
            ) : null}
            <span className="truncate">
              {language?.name ?? workspace.language}
              {socketStatus !== "open" ? " · reconnecting…" : participants.length > 1 ? ` · ${participants.length} here` : ""}
            </span>
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="App settings" onClick={() => setSettingsOpen(true)}>
          <Settings2 />
        </Button>
        {running ? (
          <Button size="sm" variant="outline" disabled={busy === "stop"} onClick={() => void stopApp()} data-testid="studio-stop">
            {busy === "stop" ? <LoaderCircle className="animate-spin" /> : <CircleStop />} Stop
          </Button>
        ) : (
          <Button size="sm" disabled={busy === "run"} onClick={() => void runApp()} data-testid="studio-run">
            {busy === "run" ? <LoaderCircle className="animate-spin" /> : <Play />} Run
          </Button>
        )}
      </div>

      {/* Phones: one pane at a time. */}
      {narrow ? (
      <>
      <div className="flex border-b border-border" role="tablist" aria-label="Studio panes">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={pane === tab.id}
              onClick={() => {
                haptic("tick");
                setPane(tab.id);
              }}
              className={cn(
                "relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-(length:--text-micro)",
                pane === tab.id ? "font-semibold text-foreground" : "text-muted-foreground",
              )}
              data-testid={`studio-tab-${tab.id}`}
            >
              <Icon className="size-4" />
              {tab.label}
              {tab.badge ? <span className="absolute top-1 right-1/4 size-1.5 rounded-full bg-primary" /> : null}
              {pane === tab.id ? <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-foreground" /> : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        {pane === "files" ? treePane : pane === "code" ? editorPane : sidePanes[pane]}
      </div>

      {/* Larger screens: files, editor, and a side panel together. */}
      </>
      ) : (
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r border-border">{treePane}</aside>
        <section className="min-w-0 flex-1">{editorPane}</section>
        <aside className="flex w-96 shrink-0 flex-col border-l border-border">
          <div className="flex border-b border-border" role="tablist" aria-label="Side panel">
            {tabs
              .filter((tab): tab is (typeof tabs)[number] & { id: SideTab } => tab.id !== "files" && tab.id !== "code")
              .map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={sideTab === tab.id}
                    onClick={() => setSideTab(tab.id)}
                    className={cn(
                      "relative flex flex-1 items-center justify-center gap-1.5 py-2 text-sm",
                      sideTab === tab.id ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                    {tab.label}
                    {tab.badge ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                    {sideTab === tab.id ? <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-foreground" /> : null}
                  </button>
                );
              })}
          </div>
          <div className="min-h-0 flex-1">{sidePanes[sideTab]}</div>
        </aside>
      </div>
      )}

      <StudioSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        name={workspace.name}
        runCommand={workspace.runCommand ?? ""}
        defaultRunCommand={language?.run ?? ""}
        saving={updateSettings.isPending}
        deleting={removeWorkspace.isPending}
        onSave={(input) => updateSettings.mutate(input)}
        onDelete={() => removeWorkspace.mutate()}
      />
    </div>
  );
}

function StudioSettingsDialog({
  open,
  onOpenChange,
  name,
  runCommand,
  defaultRunCommand,
  saving,
  deleting,
  onSave,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  runCommand: string;
  defaultRunCommand: string;
  saving: boolean;
  deleting: boolean;
  onSave: (input: { name: string; runCommand: string | null }) => void;
  onDelete: () => void;
}) {
  const [draftName, setDraftName] = useState(name);
  const [draftCommand, setDraftCommand] = useState(runCommand);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDraftName(name);
    setDraftCommand(runCommand);
    setConfirmDelete(false);
  }, [open, name, runCommand]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto">
        <DialogHeader>
          <DialogTitle>App settings</DialogTitle>
          <DialogDescription>Rename the app, change how it runs, or pick Automa's colors.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Name</span>
            <Input value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={80} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Run command</span>
            <Input
              value={draftCommand}
              onChange={(event) => setDraftCommand(event.target.value)}
              placeholder={defaultRunCommand || "Served as a static site"}
              className="font-mono text-sm"
              autoCapitalize="off"
              autoCorrect="off"
            />
            <span className="text-xs text-muted-foreground">Runs in the project folder. Web apps should listen on $PORT. Leave empty for the default.</span>
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Colors</span>
            <AppearancePicker />
          </div>
          <Button
            variant={confirmDelete ? "destructive" : "outline"}
            disabled={deleting}
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            className="self-start"
          >
            {confirmDelete ? "Tap again to delete this app and its files" : "Delete app"}
          </Button>
        </div>
        <DialogFooter className="flex-row justify-between sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving || !draftName.trim()} onClick={() => onSave({ name: draftName.trim(), runCommand: draftCommand.trim() || null })}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
