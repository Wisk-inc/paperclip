import { useEffect } from "react";
import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";
import { Mascot, type MascotPose } from "./mascot/Mascot";

/**
 * What the empty screen is about, which sets the mascot's pose:
 * `create` (nothing here yet, the action makes the first one) → excited,
 * `empty` (nothing to show, nothing to do) → confused,
 * `error` (loading or an action failed) → confused,
 * `success` (all done, e.g. an inbox at zero) → cheering.
 */
export type EmptyStateTone = "create" | "empty" | "error" | "success";

const TONE_POSE: Record<EmptyStateTone, MascotPose> = {
  create: "excited",
  empty: "confused",
  error: "confused",
  success: "cheering",
};

interface EmptyStateProps {
  icon: LucideIcon;
  /** Optional bold heading rendered above the message. */
  title?: string;
  message: string;
  /** Optional secondary line rendered under the primary message. */
  description?: string;
  action?: string;
  onAction?: () => void;
  /** Hide the leading "+" glyph on the action button (e.g. for a "Set up" CTA). */
  hideActionIcon?: boolean;
  /** Defaults to `create` when there is an action and `empty` otherwise. */
  tone?: EmptyStateTone;
}

/**
 * Empty-screen hero. Reading order is mascot → what this is → the one thing
 * to do, stacked on a single centered column so the action lands in the
 * thumb zone directly under the mascot, which looks down at it.
 */
export function EmptyState({
  icon: Icon,
  title,
  message,
  description,
  action,
  onAction,
  hideActionIcon = false,
  tone,
}: EmptyStateProps) {
  const hasAction = Boolean(action && onAction);
  const resolvedTone: EmptyStateTone = tone ?? (hasAction ? "create" : "empty");
  // The mascot's big moment (all caught up) gets the success haptic sequence.
  useEffect(() => {
    if (resolvedTone === "success") haptic("success");
  }, [resolvedTone]);
  return (
    <div className="hero-enter flex flex-col items-center justify-center gap-6 px-4 py-10 text-center md:py-16">
      <div className="relative">
        <Mascot pose={TONE_POSE[resolvedTone]} size="lg" gaze={hasAction ? "down" : "ahead"} />
        <span className="absolute bottom-0 right-0 flex size-8 items-center justify-center rounded-full border border-border bg-background">
          <Icon className="size-4 text-muted-foreground" />
        </span>
      </div>
      <div className="flex max-w-md flex-col gap-2">
        {title ? (
          <>
            <p className="font-display text-lg font-semibold tracking-tight text-foreground">{title}</p>
            <p className="text-sm text-muted-foreground">{message}</p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">{message}</p>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </>
        )}
      </div>
      {hasAction && (
        <Button
          size="lg"
          className="h-12 w-full max-w-xs sm:h-10 sm:w-auto"
          onClick={() => {
            haptic("tick");
            onAction?.();
          }}
        >
          {!hideActionIcon && <Plus className="size-4" />}
          {action}
        </Button>
      )}
    </div>
  );
}
