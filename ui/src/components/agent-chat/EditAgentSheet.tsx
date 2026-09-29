import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, Loader2, Network, ScrollText, Settings, Trash2, UserRound, Wand2 } from "lucide-react";
import { AGENT_ROLES, AGENT_ROLE_DESCRIPTIONS, AGENT_ROLE_LABELS, type Agent, type AgentRole } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { useAdapterCapabilities } from "@/adapters/use-adapter-capabilities";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { agentRouteRef, cn } from "@/lib/utils";
import { agentDetailHref } from "@/pages/agent-detail-navigation";
import { RemoveAgentDialog } from "./RemoveAgentDialog";
import { roleIcon } from "./role-icons";

const NAME_MAX = 60;
const TITLE_MAX = 80;
const CAPABILITIES_MAX = 500;

export type EditAgentTab = "profile" | "prompt";

/** A starting system prompt for a role, for agents that have none yet. */
export function starterPrompt(name: string, role: AgentRole, title: string): string {
  const label = AGENT_ROLE_LABELS[role];
  return [
    `You are ${name}, the ${title && title !== label ? `${label} (${title})` : label} of this company.`,
    "",
    AGENT_ROLE_DESCRIPTIONS[role],
    "",
    "How you work:",
    "- Answer questions directly and keep replies short unless asked for detail.",
    "- Before a big change, say what you plan to do and wait for a go-ahead.",
    "- When you finish a task, summarize what changed and what is left.",
    "- If you are blocked, say exactly what you need and from whom.",
    "",
  ].join("\n");
}

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
export function EditAgentSheet({ agent, open, onOpenChange, initialTab = "profile" }: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: EditAgentTab;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToastActions();
  const [name, setName] = useState(agent.name);
  const [title, setTitle] = useState(agent.title ?? "");
  const [role, setRole] = useState<AgentRole>((AGENT_ROLES as readonly string[]).includes(agent.role) ? (agent.role as AgentRole) : "general");
  const [reportsTo, setReportsTo] = useState<string | null>(agent.reportsTo ?? null);
  const [capabilities, setCapabilities] = useState(agent.capabilities ?? "");
  const [tab, setTab] = useState<EditAgentTab>(initialTab);
  // null until you type, so a prompt that loads late still shows.
  const [prompt, setPrompt] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(agent.name);
    setTitle(agent.title ?? "");
    setRole((AGENT_ROLES as readonly string[]).includes(agent.role) ? (agent.role as AgentRole) : "general");
    setReportsTo(agent.reportsTo ?? null);
    setCapabilities(agent.capabilities ?? "");
    setPrompt(null);
    setTab(initialTab);
  }, [open, initialTab, agent.id, agent.name, agent.title, agent.role, agent.reportsTo, agent.capabilities]);

  const getCapabilities = useAdapterCapabilities();
  const promptSupported = getCapabilities(agent.adapterType).supportsInstructionsBundle;
  const bundle = useQuery({
    queryKey: queryKeys.agents.instructionsBundle(agent.id),
    queryFn: () => agentsApi.instructionsBundle(agent.id, agent.companyId),
    enabled: open && promptSupported,
  });
  const entryFile = bundle.data?.entryFile ?? "AGENTS.md";
  const entryExists = bundle.data?.files.some((file) => file.path === entryFile) ?? false;
  const promptFile = useQuery({
    queryKey: queryKeys.agents.instructionsFile(agent.id, entryFile),
    queryFn: () => agentsApi.instructionsFile(agent.id, entryFile, agent.companyId),
    enabled: open && promptSupported && entryExists,
  });
  const savedPrompt = promptFile.data?.content ?? "";
  const promptValue = prompt ?? savedPrompt;
  const promptEditable = promptSupported && (bundle.data?.editable ?? false);
  const promptLoading = promptSupported && (bundle.isPending || (entryExists && promptFile.isPending));
  const promptChanged = promptEditable && prompt !== null && prompt !== savedPrompt;

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

  const directReports = useMemo(
    () => (agents.data ?? []).filter((item) => item.reportsTo === agent.id && item.status !== "terminated"),
    [agents.data, agent.id],
  );
  const trimmedName = name.trim();
  const fieldsChanged =
    trimmedName !== agent.name ||
    title.trim() !== (agent.title ?? "") ||
    role !== agent.role ||
    reportsTo !== (agent.reportsTo ?? null) ||
    capabilities.trim() !== (agent.capabilities ?? "");
  const changed = fieldsChanged || promptChanged;

  const save = useMutation({
    mutationFn: async () => {
      const updated = fieldsChanged
        ? await agentsApi.update(
            agent.id,
            { name: trimmedName, title: title.trim() || null, role, reportsTo, capabilities: capabilities.trim() || null },
            agent.companyId,
          )
        : agent;
      if (promptChanged && prompt !== null) {
        await agentsApi.saveInstructionsFile(
          agent.id,
          {
            path: entryFile,
            content: prompt,
            clearLegacyPromptTemplate: Boolean(bundle.data?.legacyPromptTemplateActive || bundle.data?.legacyBootstrapPromptTemplateActive),
          },
          agent.companyId,
        );
      }
      return updated;
    },
    onSuccess: async (updated) => {
      haptic("success");
      pushToast({
        title: trimmedName !== agent.name ? `Renamed to ${trimmedName}` : promptChanged && !fieldsChanged ? `${trimmedName}'s prompt saved` : `${trimmedName} updated`,
        tone: "success",
      });
      onOpenChange(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) }),
        client.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        client.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) }),
        client.invalidateQueries({ queryKey: queryKeys.agents.instructionsFile(agent.id, entryFile) }),
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
            <SheetDescription className="text-xs">Name, role, manager, and system prompt</SheetDescription>
          </div>
        </SheetHeader>
        <div className="px-4 pb-3" role="tablist" aria-label="What to edit">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {([
              { id: "profile", label: "Profile", icon: UserRound },
              { id: "prompt", label: "System prompt", icon: ScrollText },
            ] as const).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                data-tab={id}
                onClick={() => {
                  haptic("tick");
                  setTab(id);
                }}
                className={cn(
                  "inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors",
                  tab === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
                {id === "prompt" && promptChanged ? <span className="size-1.5 rounded-full bg-primary" aria-label="Unsaved" /> : null}
              </button>
            ))}
          </div>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmedName && changed && !save.isPending) save.mutate();
          }}
        >
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain border-t border-border px-4 pt-4 pb-4">
            {tab === "prompt" ? (
              <>
                <label className="grid gap-1.5 text-sm font-medium text-foreground">
                  What {trimmedName || agent.name} does
                  <Textarea
                    value={capabilities}
                    maxLength={CAPABILITIES_MAX}
                    onChange={(event) => setCapabilities(event.target.value)}
                    placeholder={AGENT_ROLE_DESCRIPTIONS[role]}
                    className="min-h-20 text-sm"
                  />
                  <span className="text-xs font-normal text-muted-foreground">
                    One or two lines. Other agents read this to decide what to hand {trimmedName || agent.name}.
                  </span>
                </label>

                <div className="grid gap-1.5" data-slot="system-prompt">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <ScrollText className="size-4 text-muted-foreground" aria-hidden="true" />
                      System prompt
                    </span>
                    {promptEditable ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
                        <FileText className="size-3" aria-hidden="true" />
                        {entryFile}
                      </span>
                    ) : null}
                  </div>
                  {!promptSupported ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                      {agent.name}&apos;s runtime takes its instructions from its own settings.{" "}
                      <Link to={agentDetailHref(agent.id, "instructions")} onClick={() => onOpenChange(false)} className="font-medium text-primary">
                        Open instructions
                      </Link>
                    </p>
                  ) : promptLoading ? (
                    <div className="h-48 animate-pulse rounded-md bg-muted" aria-label="Loading the prompt" />
                  ) : bundle.error || promptFile.error ? (
                    <p className="rounded-lg border border-destructive/40 px-3 py-2.5 text-xs text-destructive">
                      Couldn’t load the prompt: {(bundle.error ?? promptFile.error)?.message}
                    </p>
                  ) : (
                    <>
                      <Textarea
                        value={promptValue}
                        onChange={(event) => setPrompt(event.target.value)}
                        readOnly={!promptEditable}
                        placeholder={`Tell ${agent.name} who they are, how to work, and what to avoid.`}
                        spellCheck={false}
                        className="min-h-56 font-mono text-xs leading-relaxed"
                        aria-label={`${agent.name}'s system prompt`}
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          {promptValue.length.toLocaleString()} characters
                          {promptChanged ? " · unsaved" : ""}
                        </span>
                        {promptEditable ? (
                          <span className="flex items-center gap-1">
                            {promptChanged ? (
                              <Button type="button" variant="ghost" size="sm" onClick={() => setPrompt(null)}>
                                Undo changes
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                haptic("tick");
                                setPrompt(starterPrompt(trimmedName || agent.name, role, title.trim()));
                              }}
                            >
                              <Wand2 className="size-3.5" aria-hidden="true" />
                              {promptValue.trim() ? "Replace with a starter" : "Start from the role"}
                            </Button>
                          </span>
                        ) : (
                          <span>This prompt lives outside Automa and is read-only here.</span>
                        )}
                      </div>
                    </>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {agent.name} reads this at the start of every run. More files, skills, and tools are in{" "}
                    <Link to={agentDetailHref(agent.id, "instructions")} onClick={() => onOpenChange(false)} className="font-medium text-primary">
                      Instructions
                    </Link>
                    .
                  </p>
                </div>
              </>
            ) : (
            <>
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

            <div className="rounded-lg border border-border bg-card p-3" data-slot="agent-team">
              <p className="text-sm font-medium text-foreground">{agent.name}&apos;s team</p>
              {directReports.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {directReports.map((report) => (
                    <span key={report.id} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border pr-2.5 pl-0.5 text-xs text-foreground">
                      <AgentAvatar agent={report} size={24} />
                      {report.name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">Nobody reports to {agent.name} yet. Open another agent and pick {agent.name} as their manager.</p>
              )}
              <Link to="/org" onClick={() => onOpenChange(false)} className="mt-2 inline-flex text-xs font-medium text-primary">
                See the whole org chart
              </Link>
            </div>

            <div className="flex items-center gap-3 rounded-lg border border-destructive/30 p-3" data-slot="remove-agent">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">Remove {agent.name}</p>
                <p className="text-xs text-muted-foreground">
                  Deletes the agent. {directReports.length ? `${directReports.length} ${directReports.length === 1 ? "person moves" : "people move"} to the top of the org. ` : ""}
                  Tasks stay, unassigned.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => {
                  haptic("warning");
                  setConfirmRemove(true);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                Remove
              </Button>
            </div>
            </>
            )}
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

      <RemoveAgentDialog agent={agent} open={confirmRemove} onOpenChange={setConfirmRemove} onRemoved={() => onOpenChange(false)} />
    </Sheet>
  );
}
