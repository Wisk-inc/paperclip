import { TaskChatProjectCreatedCard } from "./TaskChatProjectCreatedCard";
import { TaskChatSkillCreatedCard } from "./TaskChatSkillCreatedCard";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { IssueAttachment } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { useStableEntries, useStableValue } from "@/lib/stable-value";
import { useStreamlinedTaskChatPresentation } from "./presentation-mode";
import type {
  TaskChatInteractionItem,
  TaskChatItem,
  TaskChatMessageItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
} from "./task-chat-model";
import { TaskChatTurn } from "./TaskChatTurn";
import { TaskChatBubble } from "./TaskChatBubble";
import { HeldActionsContext } from "./held-actions-context";
import { TaskChatMarker } from "./TaskChatMarker";
import { TaskChatStatusPill } from "./TaskChatStatusPill";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { TaskChatUsageReadout } from "./TaskChatUsageReadout";
import { TaskChatRunnerActivityGroup } from "./TaskChatRunnerActivityGroup";
import { TaskChatActivityPhase } from "./TaskChatActivityPhase";
import { TaskChatThinking } from "./TaskChatThinking";
import { TaskMessageScroller } from "./TaskMessageScroller";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import { TaskChatProtocolActivityRow } from "./TaskChatProtocolActivityRow";
import { TaskChatPlanPreviewCard } from "./TaskChatPlanPreviewCard";

const EMPTY_ATTACHMENTS: IssueAttachment[] = [];

interface TaskChatThreadViewProps {
  items: TaskChatItem[];
  /**
   * Content rendered above the first message INSIDE the scroll viewport (the
   * issue header when hosted by the live thread) — it scrolls away with the
   * messages instead of staying pinned above the thread.
   */
  header?: ReactNode;
  onApprovalDecision?: (statusItemId: string, optionId: string) => void;
  onRuntimeRequestDecision?: (
    item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>;
  /**
   * Renders an interleaved issue-thread interaction (the live thread supplies
   * TaskChatInteractionCard bound to its accept/reject handlers). Interaction
   * items render nothing without it — the harness has no control plane.
   */
  renderInteraction?: (item: TaskChatInteractionItem) => ReactNode;
  /**
   * Renders the description-as-first-bubble placeholder (PAP-375). The live
   * thread binds TaskChatDescriptionBubble to the issue; brief items render
   * nothing without it.
   */
  renderBrief?: () => ReactNode;
  /**
   * Renders the copy/👍/👎 action cluster prepended to an agent bubble's footer
   * line (PAP-413). The live thread binds it to the feedback-vote API; harness
   * fixtures omit it and the bubbles render actionless.
   */
  renderMessageActions?: (item: TaskChatMessageItem) => ReactNode;
  /** Full action row for any message, shown in its press-and-hold menu. */
  renderHeldMessageActions?: (item: TaskChatMessageItem) => ReactNode;
  /** Sends a message as the person, used by a bubble's "Draw again". */
  sendMessage?: (text: string) => Promise<void> | void;
  /** Renders an interrupt action beside a queued human message. */
  renderQueuedAction?: (item: TaskChatMessageItem) => ReactNode;
  /** Requeues a blocked task from its no-live-execution-path failure surfaces. */
  onTryAgainNoLiveExecutionPath?: () => Promise<void> | void;
  tryAgainNoLiveExecutionPathPending?: boolean;
  onRetryFailedRun?: (runId: string) => Promise<void> | void;
  retryFailedRunId?: string | null;
  /** Content appended inside the transcript scroller after the settled thread. */
  tail?: ReactNode;
  /** Optional streaming-aware key when `tail` changes without changing `items`. */
  contentKey?: unknown;
  className?: string;
  /** When false, render the list without the scroll container (e.g. previews). */
  scroll?: boolean;
  attachments?: IssueAttachment[];
  onOpenSkill?: (skillId: string, name: string) => void;
}

function renderItem(
  item: TaskChatItem,
  onApprovalDecision?: (statusItemId: string, optionId: string) => void,
  renderInteraction?: (item: TaskChatInteractionItem) => ReactNode,
  renderBrief?: () => ReactNode,
  renderMessageActions?: (item: TaskChatMessageItem) => ReactNode,
  renderQueuedAction?: (item: TaskChatMessageItem) => ReactNode,
  onRuntimeRequestDecision?: (
    item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>,
  activityAppearance: "classic" | "runner" = "classic",
  onTryAgainNoLiveExecutionPath?: () => Promise<void> | void,
  tryAgainNoLiveExecutionPathPending = false,
  retryableMarkerId?: string,
  onRetryFailedRun?: (runId: string) => Promise<void> | void,
  retryFailedRunId?: string | null,
  attachments: IssueAttachment[] = [],
  onOpenSkill?: (skillId: string, name: string) => void,
) {
  switch (item.kind) {
    case "project_created": return <TaskChatProjectCreatedCard item={item} />;
    case "skill_created": return <TaskChatSkillCreatedCard item={item} onOpen={onOpenSkill} />;
    case "message": {
      // Compute the actions once: the bubble renders them for a runless reply
      // (footer = actions + timestamp), while an attached turn hands them to
      // TaskChatTurn's `leading` slot so they ride the summary line and stay
      // put when the tool history expands (PAP-413). The two paths are mutually
      // exclusive at runtime, so only one host ever mounts the node.
      const actions = renderMessageActions?.(item);
      const attachedTurnItem = item.attachedTurn?.standaloneHeader
        ? {
            ...item.attachedTurn,
            agentName: item.attachedTurn.agentName ?? item.authorName,
            agentIcon: item.attachedTurn.agentIcon ?? item.agentIcon,
            agent: item.attachedTurn.agent ?? item.agent,
          }
        : item.attachedTurn;
      const turn = attachedTurnItem ? (
        <TaskChatTurn
          item={attachedTurnItem}
          timestampPrefix={
            attachedTurnItem.standaloneHeader ? undefined : item.timestamp
          }
          leading={attachedTurnItem.standaloneHeader ? undefined : actions}
          renderChild={(child) =>
            renderItem(
              child,
              onApprovalDecision,
              undefined,
              undefined,
              undefined,
              undefined,
              onRuntimeRequestDecision,
              item.attachedTurn?.standaloneHeader ? "runner" : "classic",
              undefined,
              false,
              undefined,
              undefined,
              undefined,
              attachments,
              onOpenSkill,
            )
          }
        />
      ) : undefined;
      return (
        <TaskChatBubble
          item={item}
          // Hydration and live-to-durable reconciliation may move a logical
          // message between parents. Mounting must never replay a fade.
          animateEntry={false}
          actions={
            item.attachedTurn?.standaloneHeader
              ? actions
              : item.attachedTurn
                ? undefined
                : actions
          }
          queuedAction={renderQueuedAction?.(item)}
          beforeTurn={item.attachedTurn?.standaloneHeader ? turn : undefined}
          attachedTurn={item.attachedTurn?.standaloneHeader ? undefined : turn}
          hideAgentIdentity={Boolean(item.attachedTurn?.standaloneHeader)}
          onTryAgainNoLiveExecutionPath={onTryAgainNoLiveExecutionPath}
          tryAgainNoLiveExecutionPathPending={
            tryAgainNoLiveExecutionPathPending
          }
          attachments={attachments}
        />
      );
    }
    case "marker":
      return (
        <TaskChatMarker
          item={item}
          onTryAgain={
            item.id === retryableMarkerId && item.retryable !== false
              ? item.runId && onRetryFailedRun
                ? () => onRetryFailedRun(item.runId!)
                : onTryAgainNoLiveExecutionPath
              : undefined
          }
          tryAgainPending={
            item.runId
              ? retryFailedRunId === item.runId
              : tryAgainNoLiveExecutionPathPending
          }
        />
      );
    case "thinking":
      return <TaskChatThinking item={item} />;
    case "tool":
      return <TaskChatToolCard item={item} />;
    case "status":
      return (
        <TaskChatStatusPill
          item={item}
          onApprovalDecision={(optionId) =>
            onApprovalDecision?.(item.id, optionId)
          }
        />
      );
    case "usage":
      return <TaskChatUsageReadout item={item} />;
    case "activity_phase":
      // Legacy adapter transcripts and native runner transcripts now share the
      // same compact activity treatment. Keeping this decision at the common
      // renderer boundary also gives old persisted runs the current taxonomy,
      // alignment, one-line targets, and collapsed-by-default behavior.
      return <TaskChatRunnerActivityGroup item={item} />;
    case "interaction":
      return renderInteraction ? renderInteraction(item) : null;
    case "plan_document":
      return (
        <TaskChatPlanPreviewCard
          source={{ kind: "saved", document: item.document }}
          testId={
            item.placement === "fallback"
              ? "task-chat-plan-preview-fallback"
              : "task-chat-plan-preview"
          }
        />
      );
    case "brief":
      return renderBrief ? renderBrief() : null;
    case "turn":
      return (
        <TaskChatTurn
          item={item}
          renderChild={(child) =>
            renderItem(
              child,
              onApprovalDecision,
              undefined,
              undefined,
              undefined,
              undefined,
              onRuntimeRequestDecision,
              item.standaloneHeader ? "runner" : "classic",
              undefined,
              false,
              undefined,
              undefined,
              undefined,
              attachments,
              onOpenSkill,
            )
          }
        />
      );
    case "protocol":
      return (
        <TaskChatProtocolCard
          item={item}
          onRuntimeRequestDecision={onRuntimeRequestDecision}
        />
      );
    default: {
      // Exhaustiveness guard: a new item kind must add a branch above.
      const _never: never = item;
      return _never;
    }
  }
}

/**
 * The failure that still offers Try again: the newest one, and only while no
 * reply came after it. Once the agent answered (a scheduled retry went
 * through, say), retrying the old run would only send the message twice.
 */
export function latestRetryableMarkerId(items: TaskChatItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "message" && item.author === "agent") return undefined;
    if (
      item.kind === "marker" &&
      item.variant === "interrupted" &&
      (item.label === "Run failed" || item.label === "Usage limit reached")
    ) {
      return item.id;
    }
  }
  return undefined;
}

function isSystemLikeItem(item: TaskChatItem): boolean {
  return (
    item.kind === "marker" ||
    (item.kind === "message" && item.author === "system")
  );
}

export function taskChatItemSpacingClass(
  item: TaskChatItem,
  previousItem: TaskChatItem | null,
): string | undefined {
  if (!previousItem) return undefined;
  const currentIsSystemLike = isSystemLikeItem(item);
  const previousIsSystemLike = isSystemLikeItem(previousItem);
  if (currentIsSystemLike && previousIsSystemLike) return "mt-2";
  if (currentIsSystemLike || previousIsSystemLike) return "mt-3";
  if (item.kind === "turn" || previousItem.kind === "turn") return "mt-3";
  if (item.kind === "interaction" || previousItem.kind === "interaction")
    return "mt-4";
  return "mt-6";
}

interface ThreadItemRowProps {
  item: TaskChatItem;
  className?: string;
  onApprovalDecision?: (statusItemId: string, optionId: string) => void;
  onRuntimeRequestDecision?: TaskChatThreadViewProps["onRuntimeRequestDecision"];
  renderInteraction?: (item: TaskChatInteractionItem) => ReactNode;
  renderBrief?: () => ReactNode;
  renderMessageActions?: (item: TaskChatMessageItem) => ReactNode;
  renderQueuedAction?: (item: TaskChatMessageItem) => ReactNode;
  onTryAgainNoLiveExecutionPath?: () => Promise<void> | void;
  tryAgainNoLiveExecutionPathPending: boolean;
  retryableMarkerId?: string;
  onRetryFailedRun?: (runId: string) => Promise<void> | void;
  retryFailedRunId: string | null;
  attachments: IssueAttachment[];
  onOpenSkill?: (skillId: string, name: string) => void;
  streamlined: boolean;
  /** Changes once a minute so "5m ago" labels in settled rows keep up. */
  minute: number;
}

/** A number that changes every minute while the thread is on screen. */
function useMinuteTick() {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = window.setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return minute;
}

function threadItemKey(item: TaskChatItem) {
  return item.kind === "message" ? (item.renderKey ?? item.id) : item.id;
}

/** The handlers a row of this kind actually uses; the others can change freely. */
function rowInputs(props: ThreadItemRowProps): unknown[] {
  const shared = [props.className, props.streamlined, props.minute, props.onApprovalDecision, props.onRuntimeRequestDecision, props.attachments, props.onOpenSkill];
  switch (props.item.kind) {
    case "message":
      return [
        ...shared,
        props.renderMessageActions,
        props.renderQueuedAction,
        props.onTryAgainNoLiveExecutionPath,
        props.tryAgainNoLiveExecutionPathPending,
      ];
    case "marker":
      return [
        ...shared,
        props.retryableMarkerId === props.item.id,
        props.onRetryFailedRun,
        props.retryFailedRunId,
        props.onTryAgainNoLiveExecutionPath,
        props.tryAgainNoLiveExecutionPathPending,
      ];
    case "interaction":
      return [...shared, props.renderInteraction];
    case "brief":
      return [...shared, props.renderBrief];
    default:
      return shared;
  }
}

/**
 * One thread entry. While a reply streams the list is rebuilt many times a
 * second; a settled entry whose content and handlers did not change skips
 * its redraw, so only the growing reply does work.
 */
const ThreadItemRow = memo(
  function ThreadItemRow(props: ThreadItemRowProps) {
    const { item } = props;
    const key = threadItemKey(item);
    return (
      <div
        data-thread-anchor={key}
        id={item.kind === "message" ? `comment-${item.id}` : undefined}
        className={props.className}
        data-thread-item-kind={props.streamlined ? (item.kind === "message" ? item.author : item.kind) : undefined}
      >
        {renderItem(
          item,
          props.onApprovalDecision,
          props.renderInteraction,
          props.renderBrief,
          props.renderMessageActions,
          props.renderQueuedAction,
          props.onRuntimeRequestDecision,
          "classic",
          props.onTryAgainNoLiveExecutionPath,
          props.tryAgainNoLiveExecutionPathPending,
          props.retryableMarkerId,
          props.onRetryFailedRun,
          props.retryFailedRunId,
          props.attachments,
          props.streamlined ? props.onOpenSkill : undefined,
        )}
      </div>
    );
  },
  (previous, next) => {
    if (previous.item !== next.item) return false;
    const before = rowInputs(previous);
    const after = rowInputs(next);
    return before.length === after.length && before.every((value, index) => Object.is(value, after[index]));
  },
);

/**
 * Presentational render layer for the redesigned task thread. Consumed by both
 * the live thread (adapter over comment/run props) and the dev harness
 * (synthetic fixtures). Owns no data fetching — it maps a normalized
 * TaskChatItem[] onto the primitives inside the auto-follow scroller.
 */
export function TaskChatThreadView({
  items,
  header,
  onApprovalDecision,
  onRuntimeRequestDecision,
  renderInteraction,
  renderBrief,
  renderMessageActions,
  renderHeldMessageActions,
  sendMessage,
  renderQueuedAction,
  onTryAgainNoLiveExecutionPath,
  tryAgainNoLiveExecutionPathPending = false,
  onRetryFailedRun,
  retryFailedRunId = null,
  tail,
  contentKey,
  className,
  scroll = true,
  attachments = EMPTY_ATTACHMENTS,
  onOpenSkill,
}: TaskChatThreadViewProps) {
  const streamlined = useStreamlinedTaskChatPresentation();
  const latestAgentMessageId = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === "message" && item.author === "agent") return item.id;
    }
    return null;
  }, [items]);
  const heldActionsValue = useMemo(
    () => ({ latestAgentMessageId, renderHeldActions: renderHeldMessageActions, sendMessage }),
    [latestAgentMessageId, renderHeldMessageActions, sendMessage],
  );
  // Inline actions ride only the newest agent reply; older and human messages
  // reveal them on press-and-hold through HeldActionsContext instead.
  const inlineMessageActions = useMemo(
    () =>
      renderMessageActions
        ? (item: TaskChatMessageItem) =>
            item.author === "agent" && item.id === latestAgentMessageId ? renderMessageActions(item) : null
        : undefined,
    [renderMessageActions, latestAgentMessageId],
  );
  const retryableMarkerId =
    onRetryFailedRun || onTryAgainNoLiveExecutionPath
      ? latestRetryableMarkerId(items)
      : undefined;
  // Streaming tail and header updates must not rebuild settled markdown/tool
  // trees, and a rebuilt list keeps the old object for every unchanged entry.
  const stableItems = useStableEntries(items, threadItemKey);
  const minute = useMinuteTick();
  const stableAttachments = useStableValue(attachments);
  const history = useMemo(() => {
    // Entries that draw nothing are left out, so spacing follows what shows.
    const shownItems = streamlined
      ? stableItems.filter((item) => {
          if (item.kind === "interaction") return renderInteraction ? renderInteraction(item) != null : false;
          if (item.kind === "brief") return renderBrief ? renderBrief() != null : false;
          return true;
        })
      : stableItems;
    return (
      <>
        {shownItems.map((item, index) => (
          <ThreadItemRow
            key={threadItemKey(item)}
            item={item}
            className={
              streamlined
                ? taskChatItemSpacingClass(item, shownItems[index - 1] ?? null)
                : cn(
                    index > 0 &&
                      item.kind === "interaction" &&
                      item.interaction.status !== "pending" &&
                      "-mt-3",
                  ) || undefined
            }
            streamlined={streamlined}
            minute={minute}
            onApprovalDecision={onApprovalDecision}
            onRuntimeRequestDecision={onRuntimeRequestDecision}
            renderInteraction={renderInteraction}
            renderBrief={renderBrief}
            renderMessageActions={inlineMessageActions}
            renderQueuedAction={renderQueuedAction}
            onTryAgainNoLiveExecutionPath={onTryAgainNoLiveExecutionPath}
            tryAgainNoLiveExecutionPathPending={tryAgainNoLiveExecutionPathPending}
            retryableMarkerId={retryableMarkerId}
            onRetryFailedRun={onRetryFailedRun}
            retryFailedRunId={retryFailedRunId}
            attachments={stableAttachments}
            onOpenSkill={onOpenSkill}
          />
        ))}
      </>
    );
  }, [
    stableItems, streamlined, minute, onApprovalDecision, onRuntimeRequestDecision,
    renderInteraction, renderBrief, inlineMessageActions, renderQueuedAction,
    onTryAgainNoLiveExecutionPath, tryAgainNoLiveExecutionPathPending,
    retryableMarkerId, onRetryFailedRun, retryFailedRunId, stableAttachments, onOpenSkill,
  ]);
  const body = (
    <div
      className={cn(
        "paperclip-mobile-thread mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col px-1 py-3 md:px-4 md:py-4",
        streamlined ? "md:px-0" : "gap-5",
        className,
      )}
    >
      {header ? (
        <div
          className={cn("flex flex-col gap-6", streamlined ? "pb-4" : "pb-2")}
          data-testid="task-chat-thread-header"
        >
          {header}
        </div>
      ) : null}
      {history}
      {tail ? streamlined ? <div className="mt-4">{tail}</div> : tail : null}
    </div>
  );

  const wrapped = <HeldActionsContext.Provider value={heldActionsValue}>{body}</HeldActionsContext.Provider>;
  if (!scroll) return wrapped;

  return (
    <TaskMessageScroller contentKey={contentKey ?? taskChatContentKey(items)}>
      {wrapped}
    </TaskMessageScroller>
  );
}

// Cheap content signature so streaming growth (text lengthening without the
// item count changing) still advances the auto-follow key. Shared by the
// desktop scroller above and the mobile window-scroll follow (TaskChatThread).
function signatureOf(it: TaskChatItem): number {
  if (it.kind === "message") return it.text.length + (it.attachedTurn ? 1 : 0);
  if (it.kind === "thinking") return it.lines.reduce((n, l) => n + l.length, 0);
  if (it.kind === "tool")
    return (it.diff?.lines?.length ?? 0) + (it.status === "completed" ? 1 : 0);
  if (it.kind === "plan_document") {
    return it.document.body.length + it.document.latestRevisionNumber;
  }
  if (it.kind === "turn") {
    if (it.settled) return 1 + (it.finalResponse?.text.length ?? 0);
    // The live parent row's header changes (gerund ↔ tool-state flashes,
    // streaming interstitial text growing) count too, so the collapsed
    // single-line turn still advances the key.
    const headerSig = it.liveStatus
      ? it.liveStatus.label.length +
        (it.liveStatus.detail?.length ?? 0) +
        (it.liveStatus.selfTalk?.length ?? 0)
      : 0;
    return it.items.reduce(
      (n, child) => n + signatureOf(child),
      it.items.length + headerSig + (it.finalResponse?.text.length ?? 0),
    );
  }
  if (it.kind === "activity_phase") {
    return it.items.reduce(
      (n, child) => n + signatureOf(child),
      it.summary.length + (it.interstitial?.text.length ?? 0),
    );
  }
  return 1;
}

export function taskChatContentKey(items: TaskChatItem[]): number {
  return items.reduce((acc, it) => acc + signatureOf(it), items.length);
}
