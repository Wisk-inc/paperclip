import type {
  FeedbackDataSharingPreference,
  FeedbackVoteValue,
} from "@paperclipai/shared";
import { useCopyAction } from "@/lib/use-copy-action";
import { IssueChatFeedbackButtons } from "@/components/AgentBubbleActionRow";
import { useEffect, useState } from "react";
import { Check, Copy, Trash2, X } from "lucide-react";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/** Feedback-vote wiring for an agent bubble, resolved per comment by the host. */
export interface TaskChatBubbleFeedback {
  activeVote: FeedbackVoteValue | null;
  sharingPreference: FeedbackDataSharingPreference;
  termsUrl: string | null;
  onVote: (
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
}

/**
 * Compact copy · 👍 · 👎 cluster prepended to an agent bubble's footer line
 * (PAP-413), leading the "✓ Worked · …" turn summary (or the bare timestamp
 * when the reply had no run activity). It reuses the shared
 * {@link IssueChatFeedbackButtons} so the redesigned task thread speaks the
 * same feedback language as the conference room's {@link AgentBubbleActionRow};
 * the timestamp stays owned by the summary/bubble, so it is not duplicated here.
 */
export function TaskChatBubbleActions({
  copyText,
  feedback,
  onDelete,
}: {
  copyText: string;
  feedback?: TaskChatBubbleFeedback | null;
  /** Deletes the message; the first tap arms it, the second deletes. */
  onDelete?: () => Promise<void> | void;
}) {
  const { copied, failed, copy } = useCopyAction(2000);
  const label = failed ? "Couldn’t copy message" : "Copy message";
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <div className="flex items-center gap-0.5" data-testid="task-chat-bubble-actions">
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={label}
        aria-label={label}
        onClick={() => {
          void copy(copyText);
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : failed ? (
          <X className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
      {onDelete ? (
        <button
          type="button"
          data-testid="task-chat-delete-message"
          disabled={deleting}
          className={cn(
            "inline-flex h-7 items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            armed && "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
          )}
          title={armed ? "Tap again to delete" : "Delete message"}
          aria-label={armed ? "Confirm delete message" : "Delete message"}
          onClick={() => {
            if (!armed) {
              haptic("tick");
              setArmed(true);
              return;
            }
            haptic("warning");
            setDeleting(true);
            void Promise.resolve(onDelete()).finally(() => {
              setDeleting(false);
              setArmed(false);
            });
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {armed ? <span className="text-(length:--text-micro) font-medium">Delete?</span> : null}
        </button>
      ) : null}
      {feedback ? (
        <IssueChatFeedbackButtons
          activeVote={feedback.activeVote}
          sharingPreference={feedback.sharingPreference}
          termsUrl={feedback.termsUrl}
          onVote={feedback.onVote}
        />
      ) : null}
    </div>
  );
}
