import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { resolveAgentAppearance } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "./AgentAvatar";

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
}

export function EmptyState({
  icon: Icon,
  title,
  message,
  description,
  action,
  onAction,
  hideActionIcon = false,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {/* A Paperclip character (palette picked from the message, so each empty
          state keeps its own face) with the section icon as a badge. */}
      <div className="relative mb-4">
        <AgentAvatar appearance={resolveAgentAppearance(null, title ?? message)} size={96} pose="idle" />
        <span className="absolute -bottom-1 -right-1 flex size-9 items-center justify-center rounded-full border border-border bg-background">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </span>
      </div>
      {title ? (
        <>
          <p className="text-base font-semibold text-foreground mb-1.5">{title}</p>
          <p className="text-sm text-muted-foreground mb-4 max-w-md">{message}</p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-foreground mb-1">{message}</p>
          {description && <p className="max-w-md text-sm text-muted-foreground mb-4">{description}</p>}
        </>
      )}
      {action && onAction && (
        <Button onClick={onAction}>
          {!hideActionIcon && <Plus className="h-4 w-4 mr-1.5" />}
          {action}
        </Button>
      )}
    </div>
  );
}
