import { useEffect, useMemo, useRef } from "react";
import { Clock, X } from "lucide-react";
import type { Issue } from "@paperclipai/shared";

import { Button } from "@/components/ui/button";
import { InlineBanner } from "@/components/InlineBanner";
import { cn } from "@/lib/utils";
import {
  deriveMonitorState,
  formatMonitorAbsolute,
  formatMonitorEta,
  useMonitorCountdown,
  type DerivedMonitorState,
  type MonitorDisplayState,
} from "@/lib/issue-monitor";
import { clearWaitNoticeDismissal, dismissWaitNotice, useWaitNoticeDismissed } from "@/lib/wait-notice-dismissal";

/** Matches the `Date | string` inputs accepted by the issue-monitor helpers. */
type MonitorDate = Date | string;

/** While a wait is due or overdue, the task is fetched again this often until it moves on. */
const DUE_REFRESH_MS = 20_000;

/**
 * States in which the waiting-monitor surfaces (top banner + composer strip)
 * are shown. `cleared` and `none` hide both surfaces entirely — see
 * wireframe 04 (PAP-14557).
 */
const WAITING_STATES: readonly MonitorDisplayState[] = [
  "scheduled",
  "retrying",
  "due-now",
  "overdue",
];

export function isWaitingMonitorState(state: MonitorDisplayState): boolean {
  return WAITING_STATES.includes(state);
}

export function hasVisibleMonitorSurface(issue: Issue): boolean {
  const derived = deriveMonitorState(issue);
  return isWaitingMonitorState(derived.state) && derived.nextCheckAt !== null;
}

/**
 * True from the moment a task starts waiting until the wait is over, including
 * the moments a retry is queued or running between attempts. A dismissal
 * lasts this long.
 */
function isWaitChainActive(issue: Issue): boolean {
  if (issue.status === "done" || issue.status === "cancelled") return false;
  const derived = deriveMonitorState(issue);
  if (derived.state !== "none" && derived.state !== "cleared") return true;
  const retryStatus = issue.scheduledRetry?.status;
  return retryStatus === "queued" || retryStatus === "running";
}

export interface MonitorSurfaceCopy {
  /** Prominent lead for the top banner, e.g. "Waiting on monitor — resumes in 2h 12m". */
  bannerTitle: string;
  /** Prominent lead for the composer strip, e.g. "Resumes in 2h 12m". */
  stripTitle: string;
  /** Muted detail line for the banner (absolute time carries a "(your time)" hint). */
  bannerMeta: string[];
  /** Muted detail line for the composer strip. */
  stripMeta: string[];
  /** `warning` (amber) once overdue, `info` (blue) while still on schedule. */
  tone: "info" | "warning";
  workspaceWait?: boolean;
  state: MonitorDisplayState;
  /**
   * A scheduled retry holds the task: a reply joins that retry instead of
   * waking the agent, and "Retry now" (not the monitor check) moves it up.
   */
  retry: boolean;
  /** What happens to a reply sent while waiting. */
  replyHint: string;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * Pure copy builder shared by the banner and the composer strip so both
 * surfaces render one consistent copy system (see wireframe 04). Kept free of
 * hooks/`Date.now()` so it is deterministic under test.
 */
export function buildMonitorSurfaceCopy(
  derived: DerivedMonitorState,
  now: MonitorDate,
  scheduledRetryReason?: string | null,
  options: { retryPending?: boolean } = {},
): MonitorSurfaceCopy | null {
  if (!isWaitingMonitorState(derived.state) || !derived.nextCheckAt) return null;

  if (derived.source === "scheduled-retry" && scheduledRetryReason === "workspace_busy") {
    return {
      bannerTitle: "Waiting for workspace",
      stripTitle: "Waiting for workspace",
      bannerMeta: ["Another task is using this workspace. Work starts automatically when it is available."],
      stripMeta: ["Work starts automatically when the workspace is available."],
      tone: "info",
      workspaceWait: true,
      state: derived.state,
      retry: true,
      replyHint: "You can keep sending instructions while the agent waits.",
    };
  }

  const eta = formatMonitorEta(derived.nextCheckAt, now); // "in 2h 12m" | "due now" | "overdue by 18m"
  const absolute = formatMonitorAbsolute(derived.nextCheckAt, {}, now); // local time, e.g. "Today, 4:08 PM"
  const isScheduledRetryOnly = derived.source === "scheduled-retry";
  // The server folds a reply into a pending retry (or queues it behind one),
  // so while one is pending a reply cannot wake the agent early.
  const retry = isScheduledRetryOnly || options.retryPending === true;

  let bannerTitle: string;
  let stripTitle: string;
  let statusHint: string | null = null;
  switch (derived.state) {
    case "scheduled":
    case "retrying":
      bannerTitle = isScheduledRetryOnly ? `Agent resumes ${eta}` : `Waiting on monitor — resumes ${eta}`;
      stripTitle = `Resumes ${eta}`;
      break;
    case "due-now":
      bannerTitle = isScheduledRetryOnly ? "Agent retry due now" : "Waiting on monitor — due now";
      stripTitle = "Due now";
      statusHint = "Checking momentarily…";
      break;
    case "overdue":
    default:
      bannerTitle = isScheduledRetryOnly ? `Agent retry ${eta}` : `Waiting on monitor — ${eta}`;
      stripTitle = capitalize(eta);
      statusHint = "Fires on next tick";
      break;
  }

  const attemptLabel = derived.attemptCount >= 1 ? `Attempt ${derived.attemptCount}` : null;
  const serviceLabel = derived.serviceName ? `Watching: ${derived.serviceName}` : null;

  const bannerMeta = [statusHint, `${absolute} (your time)`, attemptLabel, serviceLabel].filter(
    (piece): piece is string => Boolean(piece),
  );
  const stripMeta = [statusHint, absolute, attemptLabel, serviceLabel].filter(
    (piece): piece is string => Boolean(piece),
  );

  return {
    bannerTitle,
    stripTitle,
    bannerMeta,
    stripMeta,
    tone: derived.state === "overdue" ? "warning" : "info",
    state: derived.state,
    retry,
    replyHint: retry
      ? "Replies wait for this retry; the agent reads them when it resumes."
      : "Sending a reply wakes the agent now — before the scheduled check.",
  };
}

function useMonitorSurfaceCopy(issue: Issue): MonitorSurfaceCopy | null {
  // `nextCheckAt` is stable for a given issue; derive once to seed the ticking
  // countdown cadence, then re-derive against the live clock so the surfaces
  // roll scheduled → due → overdue on their own.
  const nextCheckAt = useMemo(() => deriveMonitorState(issue).nextCheckAt, [issue]);
  const now = useMonitorCountdown(nextCheckAt);
  return useMemo(
    () =>
      buildMonitorSurfaceCopy(deriveMonitorState(issue, now), now, issue.scheduledRetry?.scheduledRetryReason, {
        retryPending: issue.scheduledRetry?.status === "scheduled_retry",
      }),
    [issue, now],
  );
}

/** The copy to show, or null once the wait is over or the reader closed the notice. */
function useWaitNotice(issue: Issue): { copy: MonitorSurfaceCopy | null; rawCopy: MonitorSurfaceCopy | null; issueId: string | null } {
  const rawCopy = useMonitorSurfaceCopy(issue);
  const issueId = typeof issue.id === "string" && issue.id ? issue.id : null;
  const dismissed = useWaitNoticeDismissed(issueId);
  const chainActive = isWaitChainActive(issue);
  // Once the wait is over, the next one shows again.
  useEffect(() => {
    if (issueId && !chainActive) clearWaitNoticeDismissal(issueId);
  }, [issueId, chainActive]);
  return { copy: dismissed ? null : rawCopy, rawCopy, issueId };
}

function CheckNowButton({
  onCheckNow,
  checkingNow,
}: {
  onCheckNow: () => void;
  checkingNow: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0 shadow-none"
      onClick={onCheckNow}
      disabled={checkingNow}
    >
      {checkingNow ? "Checking…" : "Check now"}
    </Button>
  );
}

function RetryNowButton({ onRetryNow, retryingNow }: { onRetryNow: () => void; retryingNow: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0 shadow-none"
      onClick={onRetryNow}
      disabled={retryingNow}
    >
      {retryingNow ? "Retrying…" : "Retry now"}
    </Button>
  );
}

function DismissButton({ issueId }: { issueId: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      aria-label="Hide this notice"
      title="Hide this notice"
      onClick={() => dismissWaitNotice(issueId)}
      data-testid="wait-notice-dismiss"
    >
      <X aria-hidden="true" />
    </Button>
  );
}

/** "Retry now" for a scheduled retry, "Check now" for a monitor; nothing while waiting for a workspace. */
function WaitAction({
  copy,
  onCheckNow,
  checkingNow,
  onRetryNow,
  retryingNow,
}: {
  copy: MonitorSurfaceCopy;
  onCheckNow: (() => void) | null;
  checkingNow: boolean;
  onRetryNow: (() => void) | null;
  retryingNow: boolean;
}) {
  if (copy.workspaceWait) return null;
  // The monitor check refuses a task that only has a scheduled retry.
  if (copy.retry) return onRetryNow ? <RetryNowButton onRetryNow={onRetryNow} retryingNow={retryingNow} /> : null;
  return onCheckNow ? <CheckNowButton onCheckNow={onCheckNow} checkingNow={checkingNow} /> : null;
}

export interface IssueMonitorSurfaceProps {
  issue: Issue;
  onCheckNow?: (() => void) | null;
  checkingNow?: boolean;
  /** Moves a scheduled retry up to now. */
  onRetryNow?: (() => void) | null;
  retryingNow?: boolean;
}

/**
 * Pinned banner rendered between the issue title and description while a
 * monitor is waiting. Replaces the description-area "Monitor scheduled" card
 * for the waiting state (PAP-14557 decision 1) — the two never render at once.
 */
export function IssueMonitorBanner({
  issue,
  onCheckNow = null,
  checkingNow = false,
  onRetryNow = null,
  retryingNow = false,
  onDue = null,
}: IssueMonitorSurfaceProps & {
  /** Fetches the task again; called while the wait is due or overdue, so the notice never outlives it. */
  onDue?: (() => void) | null;
}) {
  const { copy, rawCopy, issueId } = useWaitNotice(issue);
  const onDueRef = useRef(onDue);
  onDueRef.current = onDue;
  const due = rawCopy !== null && !rawCopy.workspaceWait && (rawCopy.state === "due-now" || rawCopy.state === "overdue");
  useEffect(() => {
    if (!due || !onDueRef.current) return;
    onDueRef.current();
    const timer = setInterval(() => onDueRef.current?.(), DUE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [due]);

  if (!copy) return null;

  const action = <WaitAction copy={copy} onCheckNow={onCheckNow} checkingNow={checkingNow} onRetryNow={onRetryNow} retryingNow={retryingNow} />;
  return (
    <InlineBanner
      tone={copy.tone}
      icon={Clock}
      title={copy.bannerTitle}
      className="my-3"
      actions={
        <>
          {action}
          {issueId ? <DismissButton issueId={issueId} /> : null}
        </>
      }
    >
      <span>{copy.bannerMeta.join("  ·  ")}</span>
    </InlineBanner>
  );
}

/**
 * Slim, inline (not sticky) strip anchored directly above the reply composer.
 * Mirrors the banner's monitor state and says what a reply does while the
 * agent waits (PAP-14557 decisions 2 + wireframe 02).
 */
export function IssueMonitorComposerStrip({
  issue,
  onCheckNow = null,
  checkingNow = false,
  onRetryNow = null,
  retryingNow = false,
  className,
}: IssueMonitorSurfaceProps & { className?: string }) {
  const { copy, issueId } = useWaitNotice(issue);
  if (!copy) return null;

  return (
    <div
      role="note"
      data-testid="issue-monitor-composer-strip"
      className={cn("rounded-lg border border-border bg-muted/30 px-3 py-2", className)}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{copy.stripTitle}</div>
              <div className="text-xs text-muted-foreground">{copy.stripMeta.join(" · ")}</div>
            </div>
          </div>
          <WaitAction copy={copy} onCheckNow={onCheckNow} checkingNow={checkingNow} onRetryNow={onRetryNow} retryingNow={retryingNow} />
        </div>
        {issueId ? <DismissButton issueId={issueId} /> : null}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{copy.replyHint}</p>
    </div>
  );
}
