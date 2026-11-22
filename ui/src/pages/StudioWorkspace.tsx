import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  CircleStop,
  CodeXml,
  Ellipsis,
  Eye,
  FileArchive,
  FolderTree,
  Globe,
  History,
  LoaderCircle,
  Play,
  Settings2,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Upload,
  Users,
} from "lucide-react";
import type { EditorView } from "@codemirror/view";
import type {
  StudioAssistantTurn,
  StudioChangeRequest,
  StudioConsoleLine,
  StudioFileContent,
  StudioMessage,
  StudioPageReport,
  StudioParticipant,
  StudioRunState,
  StudioServerEvent,
} from "@paperclipai/shared";
import { ApiError, fetchApi } from "../api/client";
import { studioApi, studioSocketUrl, type StudioShareResult } from "../api/studio";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useStudioSocket } from "../hooks/useStudioSocket";
import { useNarrowScreen } from "../hooks/useNarrowScreen";
import { useUndoableAction } from "../hooks/useUndoableAction";
import { haptic } from "../lib/haptics";
import { notifyWhenAway, studioReplyNotice } from "../lib/background-notify";
import { getVisibilityHeaderValue, usePageVisibility } from "../lib/page-visibility";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PageSkeleton } from "../components/PageSkeleton";
import { Mascot } from "../components/mascot/Mascot";
import { AppearancePicker } from "../components/AppearancePicker";
import { StudioAssets } from "../components/studio/StudioAssets";
import { StudioCheckpointsSheet } from "../components/studio/StudioCheckpointsSheet";
import { STUDIO_AI_PROVIDERS, STUDIO_AI_PROVIDER_INFO, type StudioAiProvider } from "@paperclipai/shared";
import { CodeEditor } from "../components/studio/CodeEditor";
import { EditorKeyRow } from "../components/studio/EditorKeyRow";
import { StudioEditorStatus, createEditorCursorStore, type StudioSaveState } from "../components/studio/StudioEditorStatus";
import {
  StudioEditorTabs,
  existingTabs,
  isAtOrUnder,
  movedPath,
  neighbourTab,
  readRememberedTabs,
  rememberTabs,
  renameTabs,
  withTab,
  withoutTabs,
} from "../components/studio/StudioEditorTabs";
import { StudioFileTree } from "../components/studio/StudioFileTree";
import { createStudioConsoleStore, useLatestConsoleLine, type StudioConsoleStore } from "@/components/studio/console-store";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StudioConsole } from "../components/studio/StudioConsole";
import { StudioPreview } from "../components/studio/StudioPreview";
import { StudioPageProbe, type StudioProbeRequest } from "../components/studio/StudioPageProbe";
import { StudioAssistant } from "../components/studio/StudioAssistant";
import { StudioTeamPanel } from "../components/studio/StudioTeamPanel";
import { StudioTeamDashboard } from "../components/studio/StudioTeamDashboard";
import { LanguageLogo } from "../components/studio/LanguageLogo";

type Pane = "files" | "code" | "console" | "preview" | "ai" | "team" | "dashboard";
type SideTab = Exclude<Pane, "files" | "code">;
const PHONE_PANES: Pane[] = ["files", "code", "console", "preview", "ai", "dashboard", "team"];

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

type SaveState = StudioSaveState;

interface RemoteDraft {
  path: string;
  text: string;
  by: StudioParticipant;
}

const SAVE_DELAY_MS = 750;
/** How long a save that failed waits before it is sent again: longer after each failure, the last one from then on. */
const SAVE_RETRY_DELAYS_MS = [1500, 4000, 10_000, 30_000];
/** Browsers finish a request for a page that is gone only when its body is small (64 KiB for all such requests together). */
const LEAVING_SAVE_MAX_BYTES = 60_000;
/** How many versions the person's own saves returned are remembered, to know a late announcement of one. */
const OWN_VERSIONS_KEPT = 8;
const SUGGEST_STORAGE_KEY = "automa.studio.suggest";
/** How long suggestions rest after one fails, instead of asking after every pause. */
const SUGGEST_RETRY_MS = 25_500;

/** The provider and model chosen in the AI panel (shared with suggestions). */
function readAiChoice(companyId: string): { provider: StudioAiProvider; model: string } {
  try {
    const raw = window.localStorage.getItem(`automa.studio.ai.${companyId}`);
    const parsed = raw ? (JSON.parse(raw) as { provider?: string; model?: string }) : null;
    if (parsed?.provider && (STUDIO_AI_PROVIDERS as readonly string[]).includes(parsed.provider)) {
      return { provider: parsed.provider as StudioAiProvider, model: parsed.model ?? "" };
    }
  } catch {
    // storage unavailable
  }
  // The free models need no key, like the AI panel's own default.
  return { provider: "free", model: "" };
}
const DRAFT_INTERVAL_MS = 150;

/** Installing a language: a moving bar and the newest line the installer printed. */
function ToolchainInstallProgress({ requires, consoleStore }: { requires: string; consoleStore: StudioConsoleStore }) {
  // Only lines from this install, not the run before it.
  const [since] = useState(() => new Date().toISOString());
  const latest = useLatestConsoleLine(consoleStore, since);
  return (
    <div className="flex flex-col gap-1.5 border-b border-border bg-muted px-3 py-2" data-testid="studio-toolchain-installing">
      <span className="text-sm font-medium" aria-live="polite">Installing {requires} on this device…</span>
      <ProgressBar label={`Installing ${requires}`} />
      <span className="truncate font-mono text-xs text-muted-foreground">{latest || "Getting the installer ready…"}</span>
    </div>
  );
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

/** One saved version of one file, as a single comparable value. */
const versionKey = (path: string, version: string) => `${path}\n${version}`;

/**
 * The save `studioApi.writeFile` makes, sent so that the browser finishes it
 * even when the page is gone a moment later (the tab closed, another page
 * opened in it). The API client's `put` cannot ask for that, so this goes to
 * the same route through the client's `fetchApi`, with the headers the client
 * sets. A file too large for such a request goes out as a normal one, which
 * still arrives when only this screen was left and the page stays.
 */
async function writeFileWhileLeaving(workspaceId: string, input: { path: string; content: string; baseVersion: string | null }): Promise<StudioFileContent> {
  const body = JSON.stringify(input);
  const response = await fetchApi(`/api/studio/workspaces/${encodeURIComponent(workspaceId)}/file`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Paperclip-Tab-Visible": getVisibilityHeaderValue(),
      "X-Paperclip-Route": window.location.pathname,
    },
    body,
    keepalive: new Blob([body]).size <= LEAVING_SAVE_MAX_BYTES,
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(errorBody?.error ?? `Request failed: ${response.status}`, response.status, errorBody);
  }
  return (await response.json()) as StudioFileContent;
}


/**
 * Merges the transcript the server returned into what is on screen: the
 * server's copy wins for every turn it has. A turn it doesn't have stays only
 * when the server could not know it yet (a message that just went out): it is
 * newer than the server's newest turn and `arrivedSince` says it first showed
 * here after the transcript was asked for. Any other turn the server no longer
 * has is gone there (the chat was cleared on another device), so it goes here.
 */
function mergeTurns(current: StudioAssistantTurn[], server: StudioAssistantTurn[], arrivedSince: (turnId: string) => boolean) {
  const known = new Set(server.map((turn) => turn.id));
  const newest = server.reduce((latest, turn) => (turn.createdAt > latest ? turn.createdAt : latest), "");
  const extra = current.filter((turn) => !known.has(turn.id) && turn.createdAt > newest && arrivedSince(turn.id));
  return extra.length ? [...server, ...extra] : server;
}

function upsertTurn(turns: StudioAssistantTurn[], turn: StudioAssistantTurn) {
  const index = turns.findIndex((item) => item.id === turn.id);
  if (index === -1) return [...turns, turn];
  const next = [...turns];
  next[index] = turn;
  return next;
}

/** Who of the room are guests, as one comparable value. */
function guestKey(participants: StudioParticipant[]): string {
  return participants
    .filter((participant) => participant.role === "guest")
    .map((participant) => participant.id)
    .sort()
    .join(",");
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
  const [visitedPanes, setVisitedPanes] = useState<ReadonlySet<Pane>>(() => new Set<Pane>(["code"]));
  useEffect(() => {
    setVisitedPanes((current) => (current.has(pane) ? current : new Set(current).add(pane)));
  }, [pane]);
  const [sideTab, setSideTab] = useState<SideTab>("console");
  const [run, setRun] = useState<StudioRunState | null>(null);
  const consoleStore = useMemo(() => createStudioConsoleStore(), [workspaceId]);
  const [participants, setParticipants] = useState<StudioParticipant[]>([]);
  const [me, setMe] = useState<StudioParticipant | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RemoteDraft>>({});
  const [watching, setWatching] = useState<string | null>(null);
  const [turns, setTurns] = useState<StudioAssistantTurn[]>([]);
  // True once the conversation has arrived from the server, in the same draw as its turns.
  const [turnsLoaded, setTurnsLoaded] = useState(false);
  // When each turn that came live (sent from here, or over the socket) first showed here.
  const turnArrivals = useRef(new Map<string, number>());
  const noteTurnArrival = useCallback((turnId: string) => {
    if (!turnArrivals.current.has(turnId)) turnArrivals.current.set(turnId, Date.now());
  }, []);
  const [assistantRunning, setAssistantRunning] = useState(false);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  // The save state is drawn from the state; handlers that run before the next draw read the ref.
  const [saveState, drawSaveState] = useState<SaveState>("saved");
  const saveStateRef = useRef<SaveState>("saved");
  const setSaveState = useCallback((next: SaveState) => {
    saveStateRef.current = next;
    drawSaveState(next);
  }, []);
  const [share, setShare] = useState<StudioShareResult | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filesView, setFilesView] = useState<"files" | "assets">("files");
  const [suggestOn, setSuggestOn] = useState(() => {
    try {
      return window.localStorage.getItem(SUGGEST_STORAGE_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const headerUploadRef = useRef<HTMLInputElement>(null);
  // The "…" button: focus goes back to it when the settings dialog or the Checkpoints sheet closes.
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"run" | "stop" | null>(null);
  // Installing a language takes minutes and Run can be tapped meanwhile, so it has its own state.
  const [installing, setInstalling] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState<string | null>(() => {
    const state = location.state as { prompt?: string } | null;
    return state?.prompt ?? null;
  });

  const fileRef = useRef<OpenFile | null>(null);
  fileRef.current = file;
  /** Changes the open file for the next draw, and at once for handlers that run before it. */
  const putFile = useCallback((next: OpenFile) => {
    fileRef.current = next;
    setFile(next);
  }, []);
  // The open-file tabs: paths in the order they were opened, starting from the
  // ones this browser had open last time. The ref is what handlers read and
  // change (several can run before the next draw); the state draws the strip.
  const [rememberedTabs] = useState(() => readRememberedTabs(workspaceId));
  const tabsRef = useRef<string[]>(rememberedTabs.tabs);
  const [openTabs, setOpenTabs] = useState<string[]>(rememberedTabs.tabs);
  const changeTabs = useCallback((change: (tabs: string[]) => string[]) => {
    const next = change(tabsRef.current);
    if (next === tabsRef.current) return;
    tabsRef.current = next;
    setOpenTabs(next);
  }, []);
  // The live editor (for the phone's key row) and where its cursor is (for the status bar).
  const editorViewRef = useRef<EditorView | null>(null);
  const cursorStore = useMemo(() => createEditorCursorStore(), []);
  const teamVisibleRef = useRef(false);
  teamVisibleRef.current = narrow ? pane === "team" : sideTab === "team";
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The save on its way to the server, if any: the next one waits for it.
  const savingRef = useRef<Promise<boolean> | null>(null);
  // What the person's own save in flight (or the one just finished) wrote, and the versions
  // their saves returned: the server announces every save to everyone, the saver included.
  const ownSave = useRef<{ path: string; content: string } | null>(null);
  const ownVersions = useRef<string[]>([]);
  const lastDraftAt = useRef(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Data ──────────────────────────────────────────────────────────────
  const detail = useQuery({
    queryKey: queryKeys.studio.detail(workspaceId),
    queryFn: () => studioApi.get(workspaceId),
    enabled: !!workspaceId,
  });
  const workspace = detail.data?.workspace ?? null;
  // Read by the socket handler when a reply finishes out of sight.
  const runningTurnsRef = useRef(new Set<string>());
  const workspaceNameRef = useRef<string | null>(null);
  workspaceNameRef.current = workspace?.name ?? null;
  const pagePathRef = useRef("");
  pagePathRef.current = `${location.pathname}${location.search}`;

  // The invite link is not part of the project: sharing started here answers with it, and a page
  // opened again (or a code replaced on another device) asks for it, so the Team tab shows the
  // link and not only the code.
  const sharedCode = workspace?.shareEnabled ? workspace.shareCode : null;
  const knownShareCode = share?.code ?? null;
  useEffect(() => {
    if (!workspaceId || !sharedCode || knownShareCode === sharedCode) return;
    let left = false;
    studioApi.shareInfo(workspaceId).then(
      ({ share: found }) => {
        if (!left && found) setShare((current) => (current?.code === found.code ? current : found));
      },
      // The code still shows; the link comes back with the next Share.
      () => undefined,
    );
    return () => {
      left = true;
    };
  }, [workspaceId, sharedCode, knownShareCode]);

  // The preview reloads by itself a moment after files change (an agent's
  // write, a save), so it never shows a stale page.
  const [previewReload, setPreviewReload] = useState(0);
  const previewReloadTimer = useRef<number | null>(null);
  const schedulePreviewReload = useCallback(() => {
    if (previewReloadTimer.current !== null) window.clearTimeout(previewReloadTimer.current);
    previewReloadTimer.current = window.setTimeout(() => {
      previewReloadTimer.current = null;
      setPreviewReload((count) => count + 1);
    }, 1200);
  }, []);
  useEffect(
    () => () => {
      if (previewReloadTimer.current !== null) window.clearTimeout(previewReloadTimer.current);
    },
    [],
  );

  // An agent asked to see the page (view_app): it opens out of sight at the
  // size the agent asked for, and its report goes back to the agent.
  const [probes, setProbes] = useState<StudioProbeRequest[]>([]);
  const dropProbe = useCallback((requestId: string) => setProbes((current) => current.filter((probe) => probe.requestId !== requestId)), []);
  const finishProbe = useCallback(
    (request: StudioProbeRequest, report: StudioPageReport | null) => {
      dropProbe(request.requestId);
      if (report) void studioApi.previewReport(workspaceId, request.requestId, report).catch(() => undefined);
    },
    [dropProbe, workspaceId],
  );
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
  // Without the list, a saved key looks missing; say why instead.
  useEffect(() => {
    if (aiKeys.error) pushToast({ title: "Couldn't load your AI keys", body: `${errorText(aiKeys.error)}. The free models still work.`, tone: "error" });
  }, [aiKeys.error, pushToast]);
  // While the live socket is up it carries every update; the transcript is
  // only polled when the socket is down, so a poll never undoes live text.
  const [socketLive, setSocketLive] = useState(false);
  const assistant = useQuery({
    queryKey: queryKeys.studio.assistant(workspaceId),
    // `askedAt`: when this copy was asked for, to tell a turn the server does not have yet from one it no longer has.
    queryFn: async () => {
      const askedAt = Date.now();
      return { ...(await studioApi.assistant(workspaceId)), askedAt };
    },
    enabled: !!workspaceId,
    refetchInterval: assistantRunning && !socketLive ? 2550 : false,
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
      const { turns: serverTurns, askedAt } = assistant.data;
      setTurns((current) => mergeTurns(current, serverTurns, (turnId) => (turnArrivals.current.get(turnId) ?? 0) >= askedAt));
      setTurnsLoaded(true);
      setAssistantRunning(assistant.data.running);
    }
  }, [assistant.data]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void studioApi
      .console(workspaceId)
      .then((result) => {
        if (!cancelled) consoleStore.merge(result.lines);
      })
      // A project that is gone, or a dropped connection: the page already says so from its own
      // queries, and the console fills in when the socket reconnects (see below).
      .catch(() => undefined);
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
  // The guests in the room, as last seen: someone new joining means the
  // people list (where they can be removed) must be fetched again.
  const roomGuests = useRef("");
  // Closes the tabs of a deleted file or folder; true when the open file was one of them.
  // Set further down, where opening a file is defined.
  const closeDeletedRef = useRef<(path: string) => boolean>(() => false);

  /**
   * Takes in the server's copy of the open file, as a save announced it or as
   * it was read again. The person's own save coming back, or the same text
   * saved again, changes only what counts as saved, however much they typed
   * since. Someone else's change replaces a copy with no edits; over edits
   * that are not saved it is offered as the choice between theirs and mine.
   * `content` is null for a file that is not text or is too large to show.
   */
  const takeServerCopy = useCallback(
    (server: { path: string; version: string; content: string | null; size?: number }) => {
      const current = fileRef.current;
      if (!current || current.path !== server.path || server.version === current.version) return;
      // A save of the person's own that already answered: nothing new, however late it is announced.
      if (ownVersions.current.includes(versionKey(server.path, server.version))) return;
      const own = ownSave.current?.path === server.path ? ownSave.current.content : null;
      if (server.content !== null && (server.content === own || server.content === current.savedContent || server.content === current.content)) {
        putFile({ ...current, savedContent: server.content, version: server.version });
        if (server.content === current.content && saveStateRef.current !== "saving") setSaveState("saved");
        return;
      }
      if (current.content !== current.savedContent) {
        setSaveState("conflict");
        return;
      }
      const content = server.content ?? "";
      putFile({ ...current, content, savedContent: content, version: server.version, binary: server.content === null, size: server.size ?? current.size });
      setSaveState("saved");
    },
    [putFile, setSaveState],
  );

  /**
   * Reads the open file again from the server, for changes the socket did not
   * bring: it was down, or the change is one the person made here (going back
   * to a checkpoint, undoing the AI's change). A file that is gone closes the
   * way a deleted one does. `quiet` is for a read nobody asked for: a failure
   * is not announced, and a later save meets a newer version as a conflict.
   */
  const refreshOpenFile = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      // Twice at most: a copy that changed here while it was being read is read once more.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = fileRef.current;
        if (!before) return;
        let loaded: StudioFileContent;
        try {
          loaded = await studioApi.readFile(workspaceId, before.path);
        } catch (error) {
          if (fileRef.current?.path !== before.path) return;
          if (error instanceof ApiError && error.status === 404) {
            if (closeDeletedRef.current(before.path)) pushToast({ title: `${before.path} was deleted`, tone: "info" });
          } else if (!options.quiet) {
            // The open copy stays as it was; saving it later meets the newer version as a conflict.
            pushToast({ title: `Couldn't load the new version of ${before.path}`, body: errorText(error), tone: "error" });
          }
          return;
        }
        const current = fileRef.current;
        // Another file was opened meanwhile: it was read when it opened.
        if (!current || current.path !== before.path) return;
        // A save or someone's change arrived while this was read: what was read may be the older of the two.
        if (current.version !== before.version) continue;
        takeServerCopy(loaded);
        return;
      }
    },
    [pushToast, takeServerCopy, workspaceId],
  );

  const handleEvent = useCallback(
    (event: StudioServerEvent) => {
      switch (event.type) {
        case "hello":
          setMe(event.you);
          setParticipants(event.participants);
          roomGuests.current = guestKey(event.participants);
          // Who is typing is as of now: the server sends every live draft again after hello,
          // and one that ended while the socket was down is not among them.
          setDrafts({});
          break;
        case "presence": {
          setParticipants(event.participants);
          const guests = guestKey(event.participants);
          if (guests !== roomGuests.current) {
            roomGuests.current = guests;
            void queryClient.invalidateQueries({ queryKey: queryKeys.studio.collaborators(workspaceId) });
          }
          break;
        }
        case "tree:changed":
          void queryClient.invalidateQueries({ queryKey: queryKeys.studio.tree(workspaceId) });
          schedulePreviewReload();
          break;
        case "preview:probe":
          setProbes((current) =>
            current.some((probe) => probe.requestId === event.requestId)
              ? current
              : [...current, { requestId: event.requestId, viewport: event.viewport, path: event.path }].slice(-4),
          );
          // The agent stops waiting after 20 seconds; so does this page.
          window.setTimeout(() => dropProbe(event.requestId), 20_000);
          break;
        case "file:saved": {
          schedulePreviewReload();
          if (event.version === "deleted") {
            if (closeDeletedRef.current(event.path)) pushToast({ title: `${event.path} was deleted`, tone: "info" });
            break;
          }
          const current = fileRef.current;
          if (!current || current.path !== event.path) break;
          if (event.content !== null) {
            takeServerCopy(event);
            break;
          }
          // Too large to come along with the announcement. The person's own save needs no
          // reading (its answer brings the version); anyone else's is read, unless edits are open.
          if (event.version === current.version || ownVersions.current.includes(versionKey(event.path, event.version))) break;
          if (savingRef.current && ownSave.current?.path === event.path) break;
          if (current.content !== current.savedContent) setSaveState("conflict");
          else void refreshOpenFile();
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
          consoleStore.push(event.lines);
          break;
        case "console:clear":
          consoleStore.clear();
          break;
        case "assistant:cleared":
          turnArrivals.current.clear();
          setTurns([]);
          setAssistantRunning(false);
          void queryClient.invalidateQueries({ queryKey: queryKeys.studio.assistant(workspaceId) });
          break;
        case "run":
          setRun(event.state);
          break;
        case "assistant":
          noteTurnArrival(event.turn.id);
          setTurns((current) => upsertTurn(current, event.turn));
          if (event.turn.role === "assistant") {
            setAssistantRunning(!event.done);
            // A reply seen working that finishes while the person is away: tell them.
            if (!event.done) runningTurnsRef.current.add(event.turn.id);
            else if (runningTurnsRef.current.delete(event.turn.id)) {
              notifyWhenAway(
                studioReplyNotice({
                  workspaceId,
                  turnId: event.turn.id,
                  projectName: workspaceNameRef.current,
                  text: event.turn.text,
                  error: event.turn.error,
                  path: pagePathRef.current,
                }),
              );
            }
          }
          break;
        case "share":
          void queryClient.invalidateQueries({ queryKey: queryKeys.studio.detail(workspaceId) });
          break;
        case "checkpoint:restored": {
          void queryClient.invalidateQueries({ queryKey: queryKeys.studio.tree(workspaceId) });
          void refreshOpenFile();
          pushToast({ title: `Went back to “${event.checkpoint.label}”`, tone: "success" });
          break;
        }
        default:
          break;
      }
    },
    [pushToast, queryClient, workspaceId, schedulePreviewReload, dropProbe, takeServerCopy, refreshOpenFile, noteTurnArrival, setSaveState],
  );
  const socketUrl = useMemo(() => (workspaceId ? studioSocketUrl({ workspaceId }) : null), [workspaceId]);
  const { status: socketStatus, send } = useStudioSocket(socketUrl, handleEvent);
  useEffect(() => setSocketLive(socketStatus === "open"), [socketStatus]);
  // The server sends a finished reply to the person's phone only while no App Studio of theirs is on screen.
  const { visible: pageVisible } = usePageVisibility();
  useEffect(() => {
    if (socketStatus === "open") send({ type: "visibility", visible: pageVisible });
  }, [socketStatus, pageVisible, send]);
  // ── Files ─────────────────────────────────────────────────────────────
  /**
   * Saves the open file's edits; false when they could not be saved. One save
   * is on its way at a time: the next waits for it and goes out with the
   * version it returned, so the person's own save is never met as a conflict.
   * `leaving` sends it so that it arrives even when the page is gone a moment later.
   * It never rejects.
   */
  const save = useCallback(
    async (options: { force?: boolean; leaving?: boolean } = {}): Promise<boolean> => {
      while (savingRef.current) await savingRef.current;
      const current = fileRef.current;
      if (!current || current.binary || current.content === current.savedContent) return true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const content = current.content;
      const input = { path: current.path, content, baseVersion: options.force ? null : current.version };
      ownSave.current = { path: current.path, content };
      setSaveState("saving");
      const attempt = (async () => {
        try {
          const saved = options.leaving ? await writeFileWhileLeaving(workspaceId, input) : await studioApi.writeFile(workspaceId, input);
          ownVersions.current = [...ownVersions.current, versionKey(saved.path, saved.version)].slice(-OWN_VERSIONS_KEPT);
          ownSave.current = null;
          const latest = fileRef.current;
          if (latest && latest.path === saved.path) {
            if (latest.version === current.version || latest.version === saved.version) {
              putFile({ ...latest, savedContent: content, version: saved.version });
              setSaveState(latest.content === content ? "saved" : "dirty");
            } else if (saveStateRef.current === "saving") {
              // Someone's change that followed this save is already here: it stays, not this older answer.
              setSaveState(latest.content === latest.savedContent ? "saved" : "dirty");
            }
          }
          send({ type: "draft:clear", path: current.path });
          return true;
        } catch (error) {
          const refused = error instanceof ApiError && error.status === 409;
          // Refused: nothing was written. Any other failure may have reached the server (only
          // the answer was lost), so its text still counts as the person's own if it shows up there.
          if (refused) ownSave.current = null;
          // A conflict waits for the person's choice; any other failure is tried again (see below).
          setSaveState(refused ? "conflict" : "error");
          return false;
        } finally {
          savingRef.current = null;
        }
      })();
      savingRef.current = attempt;
      return attempt;
    },
    [putFile, send, setSaveState, workspaceId],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  // A save that failed for any reason but a conflict (the phone was offline for
  // a moment, the server was restarting) is sent again by itself: after a
  // pause that grows with each failure, and at once when the browser says the
  // connection is back. The socket coming back does the same (below).
  const saveFailures = useRef(0);
  useEffect(() => {
    if (saveState === "saved") saveFailures.current = 0;
    if (saveState !== "error") return;
    const delay = SAVE_RETRY_DELAYS_MS[Math.min(saveFailures.current, SAVE_RETRY_DELAYS_MS.length - 1)]!;
    saveFailures.current += 1;
    const retry = () => void save();
    const timer = setTimeout(retry, delay);
    window.addEventListener("online", retry);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", retry);
    };
  }, [saveState, save]);

  // Whatever happened while the socket was down (a reply finishing, console
  // output, a cleared chat, the open file rewritten by the AI or by going back
  // to a checkpoint) is read again as soon as it reconnects. A save that
  // failed meanwhile goes out again once the open file is known to be current.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (socketStatus !== "open") return;
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.studio.assistant(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.studio.detail(workspaceId) });
    void studioApi.console(workspaceId).then((result) => consoleStore.merge(result.lines)).catch(() => undefined);
    void refreshOpenFile({ quiet: true }).then(() => {
      if (saveStateRef.current === "error") void save();
    });
  }, [socketStatus, queryClient, workspaceId, consoleStore, refreshOpenFile, save]);

  // Grey AI suggestions in the editor, from the provider picked in the AI
  // panel, or the free models while that provider has no key (as the panel does).
  // A failed one (the server says why in `error`) rests them for a while, since
  // each ask spends the shared free allowance; a good one, or turning them off
  // and on, ends the rest. It outlasts switching files.
  const suggestRestUntil = useRef(0);
  const suggest = useCallback(
    async (input: { prefix: string; suffix: string }, signal: AbortSignal) => {
      const current = fileRef.current;
      if (!current || Date.now() < suggestRestUntil.current) return "";
      const picked = readAiChoice(companyId);
      const choice = aiKeys.data?.keys.some((key) => key.provider === picked.provider && key.connected) ? picked : { provider: "free" as const, model: "" };
      const model = choice.provider === "custom" ? choice.model : STUDIO_AI_PROVIDER_INFO[choice.provider].completionModel;
      try {
        const result = await studioApi.complete(workspaceId, { path: current.path, prefix: input.prefix, suffix: input.suffix, provider: choice.provider, model }, signal);
        if (result.error) throw new Error(result.error);
        suggestRestUntil.current = 0;
        return result.completion;
      } catch (error) {
        // Typing again cancels the ask; that is not a failure.
        if (!signal.aborted) suggestRestUntil.current = Date.now() + SUGGEST_RETRY_MS;
        throw error;
      }
    },
    [aiKeys.data, companyId, workspaceId],
  );
  const toggleSuggest = () => {
    suggestRestUntil.current = 0;
    setSuggestOn((on) => {
      try {
        window.localStorage.setItem(SUGGEST_STORAGE_KEY, on ? "off" : "on");
      } catch {
        // storage unavailable
      }
      return !on;
    });
  };

  const uploadFiles = useCallback(
    async (files: File[], folder: string | null) => {
      try {
        const result = await studioApi.upload(workspaceId, files, folder);
        haptic("success");
        pushToast({ title: result.paths.length === 1 ? `Added ${result.paths[0]}` : `Added ${result.paths.length} files`, tone: "success" });
        await queryClient.invalidateQueries({ queryKey: queryKeys.studio.tree(workspaceId) });
      } catch (error) {
        pushToast({ title: "Upload failed", body: errorText(error), tone: "error" });
      }
    },
    [pushToast, queryClient, workspaceId],
  );

  /** Opens a file in the editor and gives it a tab; false when it did not open. */
  const openFile = useCallback(
    async (path: string, options: { show?: boolean } = {}) => {
      const current = fileRef.current;
      // Opening another file replaces this one's text: edits that did not
      // save stay open instead of being thrown away.
      if (current && !(await save())) {
        pushToast({ title: `Couldn't save ${current.path}`, body: "Your edits are still open here.", tone: "error" });
        return false;
      }
      setWatching(null);
      setFileLoading(true);
      try {
        const loaded = await studioApi.readFile(workspaceId, path);
        putFile({ path: loaded.path, content: loaded.content ?? "", savedContent: loaded.content ?? "", version: loaded.version, binary: loaded.content === null, size: loaded.size });
        changeTabs((tabs) => withTab(tabs, loaded.path));
        setSaveState("saved");
        send({ type: "focus", path: loaded.path });
        if (options.show !== false) setPane("code");
        return true;
      } catch (error) {
        // A file that is not there anymore has no use for a tab.
        if (error instanceof ApiError && error.status === 404) changeTabs((tabs) => withoutTabs(tabs, path));
        pushToast({ title: `Couldn't open ${path}`, body: errorText(error), tone: "error" });
        return false;
      } finally {
        setFileLoading(false);
      }
    },
    [changeTabs, pushToast, putFile, save, send, setSaveState, workspaceId],
  );

  /** Leaves the editor empty: no file is open. */
  const showNoFile = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    fileRef.current = null;
    setFile(null);
    setSaveState("saved");
    setWatching(null);
    send({ type: "focus", path: null });
  }, [send]);

  /**
   * Closes a tab. The open file's edits are saved first, and it stays open
   * when they can't be; then the tab beside it opens, or nothing when it was
   * the last one. Any other tab just goes.
   */
  const closeTab = useCallback(
    async (path: string) => {
      if (fileRef.current?.path !== path) {
        changeTabs((tabs) => withoutTabs(tabs, path));
        return;
      }
      if (!(await save())) {
        pushToast({ title: `Couldn't save ${path}`, body: "The tab stays open so your edits are not lost.", tone: "error" });
        return;
      }
      // Another file was opened while this one saved: only the tab goes.
      const stillOpen = fileRef.current?.path === path;
      const next = stillOpen ? neighbourTab(tabsRef.current, path) : null;
      changeTabs((tabs) => withoutTabs(tabs, path));
      if (!stillOpen || (next && (await openFile(next)))) return;
      // The last tab, or the next file could not be read: nothing is open.
      if (fileRef.current?.path === path) showNoFile();
    },
    [changeTabs, openFile, pushToast, save, showNoFile],
  );

  /**
   * A file or folder was deleted: its tabs close. When the open file was one
   * of them it leaves the editor with its unsaved edits (saving them would
   * bring the file back), and the tab beside it opens. True when the open
   * file was one of them.
   */
  const closeDeleted = useCallback(
    (path: string) => {
      const deleted = (tab: string) => isAtOrUnder(tab, path);
      const current = fileRef.current;
      const next = current && deleted(current.path) ? neighbourTab(tabsRef.current, current.path, deleted) : null;
      changeTabs((tabs) => withoutTabs(tabs, path));
      if (!current || !deleted(current.path)) return false;
      showNoFile();
      if (next) void openFile(next, { show: false });
      return true;
    },
    [changeTabs, openFile, showNoFile],
  );
  closeDeletedRef.current = closeDeleted;

  // Tabs of files the tree no longer has (deleted or moved by someone else, or
  // remembered from last time) close when the tree says so. Two kinds stay:
  // the open file (one made a moment ago can be open before the tree lists
  // it), and files in a rename of the person's own that is still under way
  // (the tree can show the move before or after their tabs take the new path).
  const renaming = useRef<{ from: string; to: string } | null>(null);
  useEffect(() => {
    const nodes = tree.data?.tree;
    if (!nodes) return;
    const move = renaming.current;
    changeTabs((tabs) =>
      existingTabs(tabs, nodes, (tab) => tab === fileRef.current?.path || Boolean(move && (isAtOrUnder(tab, move.from) || isAtOrUnder(tab, move.to)))),
    );
  }, [tree.data, changeTabs]);

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
    // The file that was open last time comes back, when it is still there.
    const last = rememberedTabs.active && existingTabs([rememberedTabs.active], tree.data.tree).length ? rememberedTabs.active : null;
    const first = last ?? entry;
    if (first) void openFile(first, { show: false });
  }, [tree.data, workspace, language, openFile, rememberedTabs]);

  // The tabs are remembered per workspace in this browser, once the first file
  // is chosen (until then the open file is not known).
  useEffect(() => {
    if (!openedFirst.current || (!file && fileLoading)) return;
    rememberTabs(workspaceId, openTabs, file?.path ?? null);
  }, [workspaceId, openTabs, file?.path, fileLoading]);

  const onEdit = (value: string) => {
    const current = fileRef.current;
    if (!current) return;
    putFile({ ...current, content: value });
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

  // Leaving inside the autosave's pause (the back arrow, closing the tab, opening another
  // page in it) sends the last edit instead of dropping it; so does leaving after a save that failed.
  useEffect(() => {
    const leave = () => void saveRef.current({ leaving: true });
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      leave();
    };
  }, []);

  const reloadFromServer = async () => {
    const current = fileRef.current;
    if (!current) return;
    try {
      const loaded = await studioApi.readFile(workspaceId, current.path);
      // Another file was opened while this one was read: it is not put back.
      if (fileRef.current?.path !== current.path) return;
      ownSave.current = null;
      putFile({ ...current, content: loaded.content ?? "", savedContent: loaded.content ?? "", version: loaded.version });
      setSaveState("saved");
      send({ type: "draft:clear", path: current.path });
    } catch (error) {
      pushToast({ title: `Couldn't load ${current.path}`, body: errorText(error), tone: "error" });
    }
  };

  const deletions = useUndoableAction({
    commit: async (path) => {
      try {
        await studioApi.deleteEntry(workspaceId, path);
      } catch (error) {
        // The row comes back, six seconds after "Deleted": say so and why.
        haptic("warning");
        pushToast({ title: `Couldn't delete ${path.split("/").pop()}`, body: errorText(error), tone: "error" });
        throw error;
      }
      closeDeleted(path);
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
      // Only its own mark: Stop may have been tapped while the app was starting.
      setBusy((current) => (current === "run" ? null : current));
    }
  };

  const stopApp = async () => {
    setBusy("stop");
    try {
      const result = await studioApi.stop(workspaceId);
      setRun(result.run);
    } catch (error) {
      haptic("warning");
      pushToast({ title: "Couldn't stop the app", body: errorText(error), tone: "error" });
    } finally {
      setBusy((current) => (current === "stop" ? null : current));
    }
  };

  const installToolchain = async () => {
    setInstalling(true);
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
      setInstalling(false);
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
    // The dialog stays open with what was typed: say why nothing happened.
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn't save the settings", body: errorText(error), tone: "error" });
    },
  });
  const removeWorkspace = useMutation({
    mutationFn: () => studioApi.remove(workspaceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.studio.list(companyId) });
      navigate("/studio");
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn't delete the app", body: errorText(error), tone: "error" });
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
        renaming.current = { from, to };
        try {
          // The open file moves with its folder too: re-opened only on an exact
          // match, its next autosave wrote the old path and brought the old
          // folder back.
          const openPath = fileRef.current?.path;
          const movedTo = openPath && movedPath(openPath, from, to) !== openPath ? movedPath(openPath, from, to) : null;
          if (movedTo && !(await save())) throw new Error(`Your edits to ${openPath} didn't save, so it stayed where it is. Try again.`);
          await studioApi.move(workspaceId, { from, to });
          // The tabs and the open file take the new path as soon as the move is done.
          changeTabs((tabs) => renameTabs(tabs, from, to));
          const open = fileRef.current;
          if (movedTo && open && open.path === openPath) {
            fileRef.current = { ...open, path: movedTo };
            setFile(fileRef.current);
          }
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.tree(workspaceId) });
          if (movedTo) await openFile(movedTo);
        } catch (error) {
          pushToast({ title: "Couldn't rename", body: errorText(error), tone: "error" });
        } finally {
          renaming.current = null;
        }
      }}
      onDelete={(path) => deletions.run(path, `Deleted ${path.split("/").pop()}`)}
      onUpload={uploadFiles}
      downloadUrl={(path) => studioApi.downloadUrl(workspaceId, path)}
      archiveUrl={(path) => studioApi.archiveUrl(workspaceId, path)}
    />
  );
  const filesPane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid grid-cols-2 gap-1 border-b border-border p-1" role="tablist" aria-label="Files or assets">
        {(
          [
            ["files", "Files"],
            ["assets", "Assets"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filesView === id}
            onClick={() => setFilesView(id)}
            className={cn("rounded-md py-1 text-sm", filesView === id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50")}
            data-testid={`studio-files-view-${id}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {filesView === "files" ? (
          treePane
        ) : (
          <StudioAssets
            tree={tree.data?.tree ?? []}
            rawUrl={(path) => studioApi.rawUrl(workspaceId, path, tree.dataUpdatedAt)}
            downloadUrl={(path) => studioApi.downloadUrl(workspaceId, path)}
            onUpload={uploadFiles}
          />
        )}
      </div>
    </div>
  );

  // The editor reports its cursor to the status bar; with no editor open there is no cursor to show.
  const onEditorReady = (view: EditorView | null) => {
    editorViewRef.current = view;
    if (!view) cursorStore.set(null);
  };
  // The phone's key row types into the person's own text file, not into someone else's live edits.
  const typing = Boolean(file && !file.binary && !watchedDraft);

  const editorPane = (
    <div className="flex h-full min-h-0 flex-col">
      <StudioEditorTabs
        tabs={openTabs}
        activePath={file?.path ?? null}
        loading={fileLoading}
        dirty={Boolean(file && file.content !== file.savedContent)}
        onSelect={(path) => {
          if (path !== fileRef.current?.path) void openFile(path);
        }}
        onClose={(path) => void closeTab(path)}
        onShowFiles={
          narrow
            ? () => {
                haptic("tick");
                setPane("files");
              }
            : undefined
        }
      />
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
            <CodeEditor
              key={`watch:${file.path}`}
              path={file.path}
              value={watchedDraft.text}
              readOnly
              ariaLabel={`${watchedDraft.by.name}'s live edits`}
              onReady={onEditorReady}
              onCursor={cursorStore.set}
            />
          ) : (
            <CodeEditor
              key={file.path}
              path={file.path}
              value={file.content}
              onChange={onEdit}
              onSave={() => void save()}
              suggest={suggestOn ? suggest : null}
              onReady={onEditorReady}
              onCursor={cursorStore.set}
            />
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
      {narrow && typing ? <EditorKeyRow editorRef={editorViewRef} data-testid="studio-key-row" /> : null}
      <StudioEditorStatus path={file?.path ?? null} cursorStore={cursorStore} saveState={saveState} suggestOn={suggestOn} onToggleSuggest={toggleSuggest} />
    </div>
  );

  const consolePane = (
    <div className="flex h-full min-h-0 flex-col">
      {missingToolchain && installing ? (
        <ToolchainInstallProgress requires={missingToolchain.requires ?? "the language"} consoleStore={consoleStore} />
      ) : missingToolchain ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-2 text-sm">
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">
            {missingToolchain.requires} isn't installed on this device{missingToolchain.installCommand ? "." : `. ${missingToolchain.note ?? ""}`}
          </span>
          {missingToolchain.installCommand ? (
            <Button size="xs" disabled={installing} onClick={() => void installToolchain()}>
              {installing ? <LoaderCircle className="animate-spin" /> : null} Install
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <StudioConsole
          store={consoleStore}
          run={run}
          onClear={() => {
            consoleStore.clear();
            void studioApi.clearConsole(workspaceId).catch((error) => pushToast({ title: "Couldn't clear the console", body: errorText(error), tone: "error" }));
          }}
          onInput={async (text) => {
            try {
              await studioApi.consoleInput(workspaceId, text);
            } catch (error) {
              pushToast({ title: "Couldn't send that to the app", body: errorText(error), tone: "error" });
            }
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
      reloadSignal={previewReload}
      consoleApp={consoleApp}
      consoleStore={consoleStore}
      starting={busy === "run"}
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
          try {
            const result = await studioApi.closePublicLink(workspaceId);
            setRun(result.run);
          } catch (error) {
            pushToast({ title: "Couldn't close the public link", body: errorText(error), tone: "error" });
          }
        },
        onInstall: async () => {
          try {
            const result = await studioApi.installCloudflared(companyId);
            pushToast({ title: result.ok ? "Public links are ready" : "Couldn't set up public links", body: result.message, tone: result.ok ? "success" : "error" });
            await queryClient.invalidateQueries({ queryKey: queryKeys.studio.catalog(companyId) });
            await queryClient.refetchQueries({ queryKey: queryKeys.studio.catalog(companyId) });
          } catch (error) {
            pushToast({ title: "Couldn't set up public links", body: errorText(error), tone: "error" });
          }
        },
      }}
    />
  );

  const aiPane = (
    <StudioAssistant
      turns={turns}
      turnsLoaded={turnsLoaded}
      running={assistantRunning}
      keys={keys}
      companyId={companyId}
      previewReady={Boolean(run?.previewReady)}
      onShowPreview={() => {
        haptic("tick");
        if (narrow) setPane("preview");
        else setSideTab("preview");
      }}
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
      onSend={async (message, provider, model, attachments, thinking, team) => {
        await save();
        const sent = await studioApi.askAssistant(workspaceId, {
          message,
          provider,
          model,
          ...(attachments?.length ? { attachments } : {}),
          ...(thinking ? { thinking } : {}),
          ...(team?.length ? { team } : {}),
        });
        // Shown at once, whether or not the live socket is connected.
        noteTurnArrival(sent.turn.id);
        setTurns((current) => upsertTurn(current, sent.turn));
        setAssistantRunning(true);
      }}
      onStop={async () => {
        await studioApi.stopAssistant(workspaceId);
      }}
      onUndoEdit={async (editId) => {
        try {
          const result = await studioApi.undoEdit(workspaceId, editId);
          // The socket brings the updated step; this covers a disconnected one.
          setTurns((current) => current.map((turn) => ({ ...turn, steps: turn.steps.map((step) => (step.editId === editId ? { ...step, undone: true } : step)) })));
          pushToast({ title: `Undid the change to ${result.path}`, tone: "success" });
          // So does the file itself: the editor shows it as it is now.
          void refreshOpenFile();
        } catch (error) {
          pushToast({ title: "Couldn't undo that change", body: errorText(error), tone: "error" });
        }
      }}
      onClear={async () => {
        await studioApi.clearAssistant(workspaceId);
        turnArrivals.current.clear();
        setTurns([]);
      }}
      onUndo={async (checkpointId) => {
        try {
          await studioApi.restoreCheckpoint(workspaceId, checkpointId);
          haptic("success");
          // The socket says so too when it is up; this covers a disconnected one.
          void refreshOpenFile();
        } catch (error) {
          pushToast({ title: "Couldn't undo", body: errorText(error), tone: "error" });
        }
      }}
    />
  );

  const teamPane = (
    <StudioTeamPanel
      shareEnabled={workspace.shareEnabled}
      shareCode={share?.workspace.shareCode ?? workspace.shareCode}
      shareExpiresAt={share?.workspace.shareExpiresAt ?? workspace.shareExpiresAt}
      share={share}
      participants={participants}
      collaborators={collaborators.data?.collaborators ?? []}
      messages={messages.data?.messages ?? []}
      changeRequests={changes.data?.changeRequests ?? []}
      onShare={async (options) => {
        try {
          const result = await studioApi.share(workspaceId, options);
          setShare(result);
          haptic("success");
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.detail(workspaceId) });
        } catch (error) {
          pushToast({ title: "Couldn't start sharing", body: errorText(error), tone: "error" });
        }
      }}
      onStopSharing={async () => {
        try {
          await studioApi.stopSharing(workspaceId);
        } catch (error) {
          pushToast({ title: "Couldn't stop sharing", body: errorText(error), tone: "error" });
          return;
        }
        setShare(null);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.studio.detail(workspaceId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.studio.collaborators(workspaceId) }),
        ]);
      }}
      onRemoveCollaborator={async (collaboratorId) => {
        try {
          await studioApi.removeCollaborator(workspaceId, collaboratorId);
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.collaborators(workspaceId) });
        } catch (error) {
          pushToast({ title: "Couldn't remove them", body: errorText(error), tone: "error" });
        }
      }}
      onSendMessage={async (body, attachment) => {
        const result = await studioApi.postMessage(workspaceId, body, attachment);
        queryClient.setQueryData<{ messages: StudioMessage[] }>(queryKeys.studio.messages(workspaceId), (current) =>
          current?.messages.some((message) => message.id === result.message.id) ? current : { messages: [...(current?.messages ?? []), result.message] },
        );
      }}
      fileUrl={(attachmentId) => studioApi.sharedFileUrl(workspaceId, attachmentId)}
      onAddToProject={async (attachmentId) => {
        try {
          const result = await studioApi.addSharedFile(workspaceId, attachmentId);
          haptic("success");
          pushToast({ title: `Added ${result.path} to the project`, tone: "success" });
        } catch (error) {
          pushToast({ title: "Couldn't add the file to the project", body: errorText(error), tone: "error" });
        }
      }}
      onAccept={async (changeId, files, options) => {
        try {
          await studioApi.acceptChange(workspaceId, changeId, files, options);
          haptic("success");
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.changes(workspaceId) });
          if (fileRef.current) await reloadFromServer();
          return "accepted";
        } catch (error) {
          // Files changed since the collaborator started: the review asks before replacing them.
          const body = error instanceof ApiError ? (error.body as { details?: { code?: string; paths?: unknown } } | null) : null;
          if (body?.details?.code === "studio_change_stale" && Array.isArray(body.details.paths)) {
            return { stalePaths: body.details.paths.map(String) };
          }
          pushToast({ title: "Couldn't accept the change", body: errorText(error), tone: "error" });
          return "failed";
        }
      }}
      onReject={async (changeId) => {
        try {
          await studioApi.rejectChange(workspaceId, changeId);
          await queryClient.invalidateQueries({ queryKey: queryKeys.studio.changes(workspaceId) });
        } catch (error) {
          pushToast({ title: "Couldn't reject the change", body: errorText(error), tone: "error" });
        }
      }}
    />
  );

  const dashboardPane = <StudioTeamDashboard turns={turns} running={assistantRunning} />;

  const sidePanes: Record<SideTab, React.ReactNode> = { console: consolePane, preview: previewPane, ai: aiPane, dashboard: dashboardPane, team: teamPane };
  const tabs: Array<{ id: Pane; label: string; icon: typeof CodeXml; badge?: number | boolean }> = [
    { id: "files", label: "Files", icon: FolderTree },
    { id: "code", label: "Code", icon: CodeXml },
    { id: "console", label: "Console", icon: SquareTerminal, badge: running },
    { id: "preview", label: "Preview", icon: Globe, badge: Boolean(run?.previewReady) },
    { id: "ai", label: "AI", icon: Sparkles, badge: assistantRunning },
    { id: "dashboard", label: "Stats", icon: Activity, badge: assistantRunning || turns.some((t) => t.usage) },
    { id: "team", label: "Team", icon: Users, badge: openChanges || (participants.length > 1 ? participants.length - 1 : 0) },
  ];

  return (
    <div
      className={cn(
        "studio-ide flex min-h-0 flex-col overflow-hidden bg-background",
        // Phones: the whole screen is the IDE. The app's header and tab bar
        // sit underneath; the back arrow in the Studio bar leaves.
        narrow
          ? "studio-ide-immersive fixed inset-0 z-40 pt-(--sz-safe-top) pb-(--sz-safe-bottom)"
          : "rounded-lg border border-border md:-m-2",
      )}
      data-testid="studio-workspace"
    >
      {probes[0] && run?.previewReady && run.previewPath ? (
        <StudioPageProbe key={probes[0].requestId} previewPath={run.previewPath} request={probes[0]} onDone={(report) => finishProbe(probes[0]!, report)} />
      ) : null}
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
        <Button variant="ghost" size="icon-sm" aria-label="Upload files" title="Upload files" onClick={() => headerUploadRef.current?.click()} data-testid="studio-header-upload">
          <Upload />
        </Button>
        <input
          ref={headerUploadRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length) void uploadFiles(files, null);
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={moreButtonRef} variant="ghost" size="icon-sm" aria-label="More" data-testid="studio-more">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => setHistoryOpen(true)} data-testid="studio-history">
              <History /> Checkpoints
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={studioApi.archiveUrl(workspaceId)} download>
                <FileArchive /> Download as zip
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
              <Settings2 /> Settings and colors
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
      <div className="min-h-0 flex-1">
        {/* A pane stays mounted (hidden) once opened: switching tabs lost the
            AI composer's draft and attachments and folded every folder. */}
        {PHONE_PANES.filter((id) => id === pane || visitedPanes.has(id)).map((id) => (
          <div key={id} className={cn("h-full min-h-0", id === pane ? null : "hidden")}>
            {id === "files" ? filesPane : id === "code" ? editorPane : sidePanes[id]}
          </div>
        ))}
      </div>
      <div className="flex border-t border-border bg-card" role="tablist" aria-label="Studio panes">
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
                "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 py-1.5 text-(length:--text-micro)",
                pane === tab.id ? "font-semibold text-primary" : "text-muted-foreground",
              )}
              data-testid={`studio-tab-${tab.id}`}
            >
              <Icon className="size-5" />
              {tab.label}
              {tab.badge ? <span className="absolute top-1 right-1/4 size-1.5 rounded-full bg-primary" /> : null}
              {pane === tab.id ? <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary" /> : null}
            </button>
          );
        })}
      </div>

      {/* Larger screens: files, editor, and a side panel together. */}
      </>
      ) : (
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r border-border">{filesPane}</aside>
        <section className="min-w-0 flex-1">{editorPane}</section>
        <aside className="flex w-96 shrink-0 flex-col border-l border-border">
          {/* The open tab shows its name. The others are icons with the name as a
              tooltip until the row is wide enough for every name, so names never
              run into each other. */}
          <div className="@container flex border-b border-border" role="tablist" aria-label="Side panel">
            {tabs
              .filter((tab): tab is (typeof tabs)[number] & { id: SideTab } => tab.id !== "files" && tab.id !== "code")
              .map((tab) => {
                const Icon = tab.icon;
                const active = sideTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={tab.label}
                    title={tab.label}
                    onClick={() => setSideTab(tab.id)}
                    className={cn(
                      "relative flex min-w-9 items-center justify-center gap-1.5 px-3 py-2 text-sm whitespace-nowrap",
                      active ? "flex-initial font-medium text-foreground @lg:flex-1" : "flex-1 text-muted-foreground hover:text-foreground",
                    )}
                    data-testid={`studio-side-tab-${tab.id}`}
                  >
                    <span className="relative flex shrink-0">
                      <Icon className="size-4" />
                      {tab.badge ? <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary" /> : null}
                    </span>
                    <span className={cn("min-w-0 truncate", active ? null : "hidden @lg:inline")}>{tab.label}</span>
                    {active ? <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-foreground" /> : null}
                  </button>
                );
              })}
          </div>
          <div className="min-h-0 flex-1">{sidePanes[sideTab]}</div>
        </aside>
      </div>
      )}

      <StudioCheckpointsSheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        workspaceId={workspaceId}
        returnFocusRef={moreButtonRef}
        onRestored={() => {
          setHistoryOpen(false);
          // The socket says so too when it is up; this covers a disconnected one.
          void refreshOpenFile();
        }}
      />
      <StudioSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        returnFocusRef={moreButtonRef}
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
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What gets focus when the dialog closes: it opens from a menu item, which is gone by then. */
  returnFocusRef: React.RefObject<HTMLElement | null>;
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
      <DialogContent
        className="max-h-(--sz-85vh) overflow-y-auto"
        // No DialogTrigger, so focus is sent back to the button by hand.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
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
