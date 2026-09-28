import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Network, Settings } from "lucide-react";
import { AGENT_ROLES, AGENT_ROLE_DESCRIPTIONS, AGENT_ROLE_LABELS, type Agent, type AgentRole } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { agentRouteRef, cn } from "@/lib/utils";
import { agentDetailHref } from "@/pages/agent-detail-navigation";
import { roleIcon } from "./role-icons";

const NAME_MAX = 60;
const TITLE_MAX = 80;

/** Everyone who reports to `agentId`, directly or not: they cannot become its manager. */
function reportsUnder(agentId: string, agents: Agent[]): Set<string> {
  const below = new Set<string>();
  let frontier = [agentId];
  while (frontier.length) {
    const next: string[] = [];
    for (const agent of agents) {
      if (agent.reportsTo && frontier.includes(agent.reportsTo) && !below.has(agent.id)) {
        below.add(agent.id);
        next.push(agent.id);
      }
    }
    frontier = next;
  }
  return below;
}

/**
 * Rename an agent and change its place in the company: its role (from the
 * full role list, with what each role does), its job title, and who it
 * reports to. Opened from the chat header, the chat welcome, and Chats.
 */
export function EditAgentSheet({ agent, open, onOpenChange }: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToastActions();
  const [name, setName] = useState(agent.name);
  const [title, setTitle] = useState(agent.title ?? "");
  const [role, setRole] = useState<AgentRole>((AGENT_ROLES as readonly string[]).includes(agent.role) ? (agent.role as AgentRole) : "general");
  const [reportsTo, setReportsTo] = useState<string | null>(agent.reportsTo ?? null);

  useEffect(() => {
    if (!open) return;
    setName(agent.name);
    setTitle(agent.title ?? "");
    setRole((AGENT_ROLES as readonly string[]).includes(agent.role) ? (agent.role as AgentRole) : "general");
    setReportsTo(agent.reportsTo ?? null);
  }, [open, agent.id, agent.name, agent.title, agent.role, agent.reportsTo]);

  const agents = useQuery({
    queryKey: queryKeys.agents.list(agent.companyId),
    queryFn: () => agentsApi.list(agent.companyId),
    enabled: open,
  });
  const managers = useMemo(() => {
    const all = (agents.data ?? []).filter((item) => item.status !== "terminated");
    const blocked = reportsUnder(agent.id, all);
    return all.filter((item) => item.id !== agent.id && !blocked.has(item.id));
  }, [agents.data, agent.id]);

  const trimmedName = name.trim();
  const changed =
    trimmedName !== agent.name ||
    title.trim() !== (agent.title ?? "") ||
    role !== agent.role ||
    reportsTo !== (agent.reportsTo ?? null);

  const save = useMutation({
    mutationFn: () =>
      agentsApi.update(agent.id, { name: trimmedName, title: title.trim() || null, role, reportsTo }, agent.companyId),
    onSuccess: async (updated) => {
      haptic("success");
      pushToast({ title: trimmedName === agent.name ? `${trimmedName} updated` : `Renamed to ${trimmedName}`, tone: "success" });
      onOpenChange(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) }),
        client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
      ]);
      // A new name gives the agent a new address; keep an open chat on it.
      const oldRef = agentRouteRef(agent);
      const newRef = agentRouteRef(updated ?? { ...agent, name: trimmedName, urlKey: null });
      const chatPath = new RegExp(`/chats/${oldRef}(?=$|[/?#])`);
      if (oldRef !== newRef && chatPath.test(location.pathname)) {
        navigate(location.pathname.replace(chatPath, `/chats/${newRef}`), { replace: true });
      }
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn’t save", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-xl md:-translate-x-1/2"
        data-testid="edit-agent-sheet"
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
        <SheetHeader className="flex-row items-center gap-3 px-4 pt-3 pb-3">
          <AgentAvatar agent={{ ...agent, name: trimmedName || agent.name }} size={48} pose="success" />
          <div className="min-w-0">
            <SheetTitle className="truncate text-base">Edit {agent.name}</SheetTitle>
            <SheetDescription className="text-xs">Name, role, and who they report to</SheetDescription>
          </div>
        </SheetHeader>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmedName && changed && !save.isPending) save.mutate();
          }}
        >
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain border-t border-border px-4 pt-4 pb-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Name
                <Input
                  value={name}
                  maxLength={NAME_MAX}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Agent name"
                  aria-invalid={!trimmedName}
                  autoComplete="off"
                  className="h-11"
                />
                <span className={cn("text-xs font-normal", trimmedName ? "text-muted-foreground" : "text-destructive")}>
                  {trimmedName ? `${trimmedName.length}/${NAME_MAX}` : "Give your agent a name"}
                </span>
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Job title
                <Input
                  value={title}
                  maxLength={TITLE_MAX}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={AGENT_ROLE_LABELS[role]}
                  autoComplete="off"
                  className="h-11"
                />
                <span className="text-xs font-normal text-muted-foreground">Optional, shown under the name</span>
              </label>
            </div>

            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium text-foreground">Role</legend>
              <div className="grid grid-cols-2 gap-2">
                {AGENT_ROLES.map((item) => {
                  const Icon = roleIcon(item);
                  const active = item === role;
                  return (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={active}
                      data-role={item}
                      onClick={() => {
                        haptic("tick");
                        setRole(item);
                      }}
                      className={cn(
                        "flex min-h-16 flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors",
                        active ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/60",
                      )}
                    >
                      <span className="flex w-full items-center gap-2">
                        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{AGENT_ROLE_LABELS[item]}</span>
                        {active ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
                      </span>
                      <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{AGENT_ROLE_DESCRIPTIONS[item]}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
                <Network className="size-4 text-muted-foreground" aria-hidden="true" />
                Reports to
              </legend>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={reportsTo === null}
                  onClick={() => setReportsTo(null)}
                  className={cn(
                    "inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm transition-colors",
                    reportsTo === null ? "border-primary bg-accent font-medium" : "border-border bg-card hover:bg-accent/60",
                  )}
                >
                  Nobody (top of the org)
                </button>
                {managers.map((manager) => (
                  <button
                    key={manager.id}
                    type="button"
                    aria-pressed={reportsTo === manager.id}
                    onClick={() => setReportsTo(manager.id)}
                    className={cn(
                      "inline-flex h-10 items-center gap-2 rounded-full border pr-3 pl-1.5 text-sm transition-colors",
                      reportsTo === manager.id ? "border-primary bg-accent font-medium" : "border-border bg-card hover:bg-accent/60",
                    )}
                  >
                    <AgentAvatar agent={manager} size={24} />
                    <span className="max-w-32 truncate">{manager.name}</span>
                    <span className="text-xs text-muted-foreground">{AGENT_ROLE_LABELS[manager.role as AgentRole] ?? manager.role}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <Button variant="ghost" asChild>
              <Link to={agentDetailHref(agent.id, "runtime")} onClick={() => onOpenChange(false)}>
                <Settings className="size-4" aria-hidden="true" />
                All settings
              </Link>
            </Button>
            <Button type="submit" disabled={!trimmedName || !changed || save.isPending} className="min-w-28">
              {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Save
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
