/**
 * Notifications for AI work that finishes while Automa is out of sight: an
 * agent's reply on a task or chat the person is waiting on, or an App Studio
 * reply. Inside the Automa app they are Android notifications (posted through
 * the app's bridge); in a browser they are system notifications, once the
 * person allowed them. Tapping one opens the screen it names.
 *
 * Nothing shows while the page is visible: the person is already looking.
 * When the server can send push itself (a Firebase service account), it sends
 * the same notification with the same tag, so the phone shows one, not two.
 */

import { automaNative, isAutomaApp } from "./automa-native";
import { tryCreateWebSocket } from "./websocket";
import { buildSameOriginWebSocketUrl } from "./websocket-url";

export interface AwayNotice {
  title: string;
  body?: string;
  /** Board path that tapping the notification opens. */
  path: string;
  /** One notification per tag: a newer one for the same task replaces it. */
  tag: string;
  /** Shown at most once: repeats of the same key (the server resends final statuses) are dropped. */
  key: string;
}

const SEEN_LIMIT = 300;
const seen = new Set<string>();

/** False when this key was already handled. */
function firstTime(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
  return true;
}

export function pageIsAway(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Markdown and extra space out, cut to `max` characters. */
export function plainSnippet(text: string, max = 200): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

type PathOpener = (path: string) => void;
let openPathInBoard: PathOpener = (path) => {
  if (typeof window !== "undefined") window.location.assign(path);
};

/** The board's router navigation, so a clicked browser notification opens the screen without a reload. */
export function setNotificationPathOpener(open: PathOpener | null) {
  openPathInBoard = open ?? ((path) => window.location.assign(path));
}

/** A browser notification the service worker shows asks the open tab to go here. */
export function handleServiceWorkerMessage(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const message = data as { type?: unknown; path?: unknown };
  if (message.type !== "automa:open-path" || typeof message.path !== "string") return false;
  if (!message.path.startsWith("/") || message.path.startsWith("//")) return false;
  openPathInBoard(message.path);
  return true;
}

async function showInBrowser(notice: AwayNotice, body: string | undefined): Promise<boolean> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  // `renotify` makes a newer reply on the same task alert again; TypeScript's DOM types omit it.
  const options = { body, tag: notice.tag, renotify: true, icon: "/android-chrome-192x192.png", data: { path: notice.path } } as NotificationOptions;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      await registration.showNotification(notice.title, options);
      return true;
    }
  } catch {
    // No worker (private window, dev server): a page notification below.
  }
  try {
    const notification = new Notification(notice.title, options);
    notification.onclick = () => {
      window.focus();
      openPathInBoard(notice.path);
      notification.close();
    };
    return true;
  } catch {
    // Android Chrome only allows worker notifications.
    return false;
  }
}

/** Shows `notice` when the page is out of sight; true when it was posted. */
export function notifyWhenAway(notice: AwayNotice): boolean {
  if (!firstTime(notice.key) || !pageIsAway()) return false;
  const title = plainSnippet(notice.title, 120);
  const body = notice.body ? plainSnippet(notice.body, 240) : undefined;
  if (isAutomaApp()) return automaNative.notify({ title, body, path: notice.path, tag: notice.tag });
  void showInBrowser({ ...notice, title }, body);
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

const ASKED_KEY = "automa.notifications.asked";

/**
 * Asks once (the first time the person sends work to an AI) whether Automa
 * may notify them. Call it from the send click: browsers want a gesture.
 */
export function askForNotificationsOnce() {
  try {
    if (localStorage.getItem(ASKED_KEY)) return;
    localStorage.setItem(ASKED_KEY, new Date().toISOString());
  } catch {
    return;
  }
  if (isAutomaApp()) {
    automaNative.requestNotifications();
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission().catch(() => undefined);
  }
}

// ── Tasks and chats the person waits on ─────────────────────────────────

/** How long a task the person wrote to stays watched. */
const WATCH_MS = 6 * 60 * 60 * 1000;
const WATCH_STORE = "automa.notifications.watching";

interface Watch {
  path: string;
  until: number;
}

const watched = new Map<string, Watch>();
const onScreen = new Map<string, string>();
let watchesLoaded = false;

function loadWatches() {
  if (watchesLoaded) return;
  watchesLoaded = true;
  try {
    // A board update reloads a hidden tab; the watches outlive that.
    const stored = JSON.parse(sessionStorage.getItem(WATCH_STORE) ?? "{}") as Record<string, Watch>;
    for (const [issueId, watch] of Object.entries(stored)) {
      if (typeof watch?.path === "string" && typeof watch.until === "number") watched.set(issueId, watch);
    }
  } catch {
    // Storage blocked: watches last for this page only.
  }
}

function saveWatches() {
  try {
    sessionStorage.setItem(WATCH_STORE, JSON.stringify(Object.fromEntries(watched)));
  } catch {
    // Storage blocked: watches last for this page only.
  }
}

/** The person wrote to this task or chat: notify them about its replies for the next hours. */
export function watchIssueReplies(issueId: string, path: string, now = Date.now()) {
  loadWatches();
  watched.set(issueId, { path, until: now + WATCH_MS });
  saveWatches();
}

/** The task or chat on screen is watched while it is open; call the result when it closes. */
export function showingIssue(issueId: string, path: string): () => void {
  onScreen.set(issueId, path);
  return () => {
    if (onScreen.get(issueId) === path) onScreen.delete(issueId);
  };
}

/** Where to open a watched task, or null when nobody waits on it. */
export function watchedIssuePath(issueId: string, now = Date.now()): string | null {
  loadWatches();
  const open = onScreen.get(issueId);
  if (open) return open;
  const watch = watched.get(issueId);
  if (!watch) return null;
  if (watch.until > now) return watch.path;
  watched.delete(issueId);
  saveWatches();
  return null;
}

export function hasWatchedIssues(now = Date.now()): boolean {
  loadWatches();
  if (onScreen.size > 0) return true;
  for (const [issueId, watch] of watched) {
    if (watch.until > now) return true;
    watched.delete(issueId);
  }
  return false;
}

export interface RunOutcome {
  runId: string;
  issueId: string;
  status: string;
  finalText?: string | null;
  error?: string | null;
}

/** The notification for a finished run, or null when there is nothing to tell (still running, stopped by the person). */
export function runOutcomeNotice(run: RunOutcome, agentName: string | null, path: string): AwayNotice | null {
  const who = agentName?.trim() || "Your agent";
  const reply = run.finalText?.trim() ? run.finalText : null;
  let title: string;
  let body: string;
  if (run.status === "succeeded") {
    title = reply ? `${who} replied` : `${who} finished`;
    body = reply ?? "Open it to see what changed.";
  } else if (run.status === "failed" || run.status === "timed_out") {
    title = `${who} couldn't finish`;
    body = run.error?.trim() || (run.status === "timed_out" ? "It ran out of time." : "Open it to see what happened.");
  } else {
    return null;
  }
  return { title, body, path, tag: `issue:${run.issueId}`, key: `run:${run.runId}` };
}

function readRunOutcome(payload: Record<string, unknown>): RunOutcome | null {
  const { runId, issueId, status } = payload;
  if (typeof runId !== "string" || typeof issueId !== "string" || typeof status !== "string") return null;
  return {
    runId,
    issueId,
    status,
    finalText: typeof payload.finalText === "string" ? payload.finalText : null,
    error: typeof payload.error === "string" ? payload.error : null,
  };
}

/** News older than this is not news: a status the server sent again after a while, or a replay. */
const STALE_OUTCOME_MS = 10 * 60 * 1000;
const FINAL_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled", "interrupted"]);

/**
 * A run outcome the person saw arrive on screen. The server sends final
 * statuses again until it is sure they went out; a repeat that reaches the
 * page after the person left must not announce a reply they already read.
 */
export function noteRunOutcomeSeen(payload: Record<string, unknown>) {
  if (typeof payload.runId === "string" && typeof payload.status === "string" && FINAL_STATUSES.has(payload.status)) {
    firstTime(`run:${payload.runId}`);
  }
}

/** A run status event: notifies when the page is away and the person waits on that task. */
export function notifyRunOutcomeWhenAway(payload: Record<string, unknown>, nameOf: (agentId: string) => string | null, now = Date.now()): boolean {
  const run = readRunOutcome(payload);
  if (!run) return false;
  const finishedAt = typeof payload.finishedAt === "string" ? Date.parse(payload.finishedAt) : Number.NaN;
  if (Number.isFinite(finishedAt) && now - finishedAt > STALE_OUTCOME_MS) return false;
  const path = watchedIssuePath(run.issueId);
  if (!path) return false;
  const notice = runOutcomeNotice(run, typeof payload.agentId === "string" ? nameOf(payload.agentId) : null, path);
  return notice ? notifyWhenAway(notice) : false;
}

/**
 * While the page is hidden the board closes its live connection (so phones
 * stay idle). When the person waits on a reply, this quiet connection stays
 * to notify them when it lands; it reads run outcomes and refetches nothing.
 */
export function startAwayReplyWatch(companyId: string, nameOf: (agentId: string) => string | null): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const connect = () => {
    if (stopped || !hasWatchedIssues()) return;
    socket = tryCreateWebSocket(buildSameOriginWebSocketUrl(`/api/companies/${encodeURIComponent(companyId)}/events/ws`));
    if (!socket) return retry();
    socket.onopen = () => {
      attempt = 0;
    };
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") return;
      try {
        const event = JSON.parse(message.data) as { type?: string; companyId?: string; payload?: Record<string, unknown> };
        if (event.type !== "heartbeat.run.status" || event.companyId !== companyId || !event.payload) return;
        notifyRunOutcomeWhenAway(event.payload, nameOf);
      } catch {
        // Not an event.
      }
    };
    socket.onclose = () => {
      socket = null;
      retry();
    };
  };

  const retry = () => {
    if (stopped || retryTimer) return;
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5)));
  };

  connect();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    const open = socket;
    socket = null;
    if (open) {
      open.onclose = null;
      try {
        open.close(1000, "page_visible");
      } catch {
        // Already closed.
      }
    }
  };
}

/** An App Studio reply that finished while the page was away. */
export function studioReplyNotice(input: {
  workspaceId: string;
  turnId: string;
  projectName: string | null;
  text: string;
  error: string | null;
  path: string;
}): AwayNotice {
  const project = input.projectName?.trim() || "your project";
  return {
    title: `App Studio · ${project}`,
    body: input.error ? `Couldn't finish: ${input.error}` : input.text.trim() || "The team finished. Open it to see the changes.",
    path: input.path,
    tag: `studio:${input.workspaceId}`,
    key: `studio-turn:${input.turnId}`,
  };
}

/** Test seam: forget what was shown and watched. */
export function resetBackgroundNotifyForTests() {
  seen.clear();
  watched.clear();
  onScreen.clear();
  watchesLoaded = false;
}
