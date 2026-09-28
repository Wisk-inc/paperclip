import { useState } from "react";
import { Pencil } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { EditAgentSheet } from "./EditAgentSheet";

const STATUS_DOT: Record<string, { className: string; label: string }> = {
  running: { className: "bg-emerald-500 motion-safe:animate-pulse", label: "Working now" },
  active: { className: "bg-emerald-500", label: "Ready" },
  idle: { className: "bg-emerald-500", label: "Ready" },
  paused: { className: "bg-amber-500", label: "Paused" },
  error: { className: "bg-red-500", label: "Needs attention" },
  pending_approval: { className: "bg-amber-500", label: "Waiting for approval" },
};

export function agentStatusLabel(status: string): string {
  return STATUS_DOT[status]?.label ?? status;
}

/** The agent's character with a live status dot (green ready, pulsing while it works). */
export function AgentStatusAvatar({ agent, size = 24 }: { agent: Agent; size?: 24 | 32 | 40 | 48 }) {
  const dot = STATUS_DOT[agent.status];
  return (
    <span className="relative inline-flex shrink-0" title={dot?.label}>
      <AgentAvatar agent={agent} size={size} pose={agent.status === "running" ? "working" : "rest"} />
      {dot ? (
        <span
          aria-label={dot.label}
          role="img"
          className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background", dot.className)}
        />
      ) : null}
    </span>
  );
}

/** Opens the Edit agent sheet (rename, role, reports to). */
export function EditAgentButton({ agent, variant = "icon" }: { agent: Agent; variant?: "icon" | "pill" }) {
  const [open, setOpen] = useState(false);
  const openSheet = () => {
    haptic("tick");
    setOpen(true);
  };
  return (
    <>
      {variant === "icon" ? (
        <Button variant="ghost" size="icon-xs" aria-label={`Edit ${agent.name}`} title={`Rename or change ${agent.name}'s role`} onClick={openSheet} data-slot="edit-agent">
          <Pencil className="size-3.5" aria-hidden="true" />
        </Button>
      ) : (
        <button
          type="button"
          onClick={openSheet}
          data-slot="edit-agent"
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95"
        >
          <Pencil className="size-3" aria-hidden="true" />
          Rename or change role
        </button>
      )}
      <EditAgentSheet agent={agent} open={open} onOpenChange={setOpen} />
    </>
  );
}
