import { useMemo, useState } from "react";
import { ChevronDown, Crown, UserRoundPlus, Users } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent, type AgentRole } from "@paperclipai/shared";
import type { OrgNode } from "@/api/agents";
import { AgentStatusAvatar, EditAgentButton } from "@/components/agent-chat/AgentChatHeader";
import { roleIcon } from "@/components/agent-chat/role-icons";
import { ModelLogo } from "@/components/ModelLogo";
import { haptic } from "@/lib/haptics";
import { modelDisplayName } from "@/lib/model-brand";
import { Link } from "@/lib/router";
import { agentRouteRef, cn } from "@/lib/utils";

function countDescendants(node: OrgNode): number {
  return node.reports.reduce((total, child) => total + 1 + countDescendants(child), 0);
}

function OrgRow({ node, lookup, depth }: { node: OrgNode; lookup: Map<string, Agent>; depth: number }) {
  const agent = lookup.get(node.id);
  const [open, setOpen] = useState(true);
  const RoleIcon = roleIcon(node.role);
  const roleLabel = AGENT_ROLE_LABELS[node.role as AgentRole] ?? node.role;
  const model = typeof agent?.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const team = countDescendants(node);
  return (
    <li data-org-node={node.id}>
      <div className={cn("flex items-center gap-1 rounded-lg transition-colors hover:bg-accent/60", depth === 0 && "bg-card")}>
        {node.reports.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `Hide ${node.name}'s team` : `Show ${node.name}'s team`}
            onClick={() => {
              haptic("tick");
              setOpen(!open);
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} aria-hidden="true" />
          </button>
        ) : (
          <span className="size-8 shrink-0" aria-hidden="true" />
        )}
        {agent ? (
          <Link
            to={`/chats/${agentRouteRef(agent)}`}
            onClick={() => haptic("tick")}
            className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 active:opacity-80"
          >
            <AgentStatusAvatar agent={agent} size={32} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="truncate text-sm font-semibold text-foreground">{node.name}</span>
                {depth === 0 && node.reports.length > 0 && node.role !== "ceo" ? <Crown className="size-3 shrink-0 self-center text-amber-500" aria-label="Leads the team" /> : null}
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <RoleIcon className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{agent.title && agent.title !== roleLabel ? `${roleLabel} · ${agent.title}` : roleLabel}</span>
              </span>
              {model ? (
                <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground/80">
                  <ModelLogo modelId={model} adapterType={agent.adapterType} size="xs" tile={false} />
                  <span className="truncate">{modelDisplayName(model)}</span>
                </span>
              ) : null}
            </span>
          </Link>
        ) : (
          <span className="min-w-0 flex-1 py-2 text-sm font-semibold">{node.name}</span>
        )}
        {team > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs tabular-nums text-muted-foreground" title={`${team} in ${node.name}'s team`}>
            <Users className="size-3" aria-hidden="true" />
            {team}
          </span>
        ) : null}
        {agent ? <span className="shrink-0 pr-1"><EditAgentButton agent={agent} /></span> : null}
      </div>
      {open && node.reports.length > 0 ? (
        <ul className="mt-1 ml-4 space-y-1 border-l border-border pl-2">
          {node.reports.map((child) => (
            <OrgRow key={child.id} node={child} lookup={lookup} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The organization on a phone: who leads, who reports to whom, and who is not
 * placed yet, as a readable tree instead of a zoomable canvas. Tap an agent to
 * chat; the pencil renames it or moves it (role, manager).
 */
export function OrgTree({ orgTree, agents, className }: { orgTree: OrgNode[]; agents: Agent[]; className?: string }) {
  const lookup = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const leaders = orgTree.filter((node) => node.reports.length > 0);
  const flat = leaders.length === 0;
  const unplaced = flat ? [] : orgTree.filter((node) => node.reports.length === 0);
  const tops = flat ? orgTree : leaders;
  const total = orgTree.reduce((sum, node) => sum + 1 + countDescendants(node), 0);
  const lead = leaders[0] ? lookup.get(leaders[0].id) : undefined;

  return (
    <section className={cn("flex flex-col gap-3", className)} aria-label="Organization" data-testid="org-tree">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent">
          <Users className="size-5 text-foreground" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Your organization</p>
          <p className="text-xs text-muted-foreground">
            {total} {total === 1 ? "agent" : "agents"}
            {lead ? ` · led by ${lead.name} (${AGENT_ROLE_LABELS[lead.role as AgentRole] ?? lead.role})` : ""}
            {unplaced.length ? ` · ${unplaced.length} not placed` : ""}
          </p>
        </div>
      </div>

      {flat ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
          Nobody reports to anyone yet. Tap the pencil on an agent and pick who they report to, and the chart builds itself.
        </p>
      ) : null}

      <ul className="space-y-1">
        {tops.map((node) => (
          <OrgRow key={node.id} node={node} lookup={lookup} depth={0} />
        ))}
      </ul>

      {unplaced.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 px-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <UserRoundPlus className="size-3.5" aria-hidden="true" />
            Not placed yet
          </h3>
          <p className="px-1 text-xs text-muted-foreground">They report to nobody. Tap the pencil to give them a manager.</p>
          <ul className="space-y-1">
            {unplaced.map((node) => (
              <OrgRow key={node.id} node={node} lookup={lookup} depth={1} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
