import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImagePlus, KeyRound, MessagesSquare, Pin, Search, Sparkles } from "lucide-react";
import { AGENT_ROLE_LABELS, type AgentRole, type AiProvider, type Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { aiConnectionsApi } from "@/api/ai-connections";
import { authApi } from "@/api/auth";
import { ByokKeysCard } from "@/components/agent-chat/ByokKeysCard";
import { AgentStatusAvatar } from "@/components/agent-chat/AgentChatHeader";
import { ChatOptionsMenu } from "@/components/agent-chat/ChatOptionsMenu";
import { roleIcon } from "@/components/agent-chat/role-icons";
import { EmptyState } from "@/components/EmptyState";
import { Mascot } from "@/components/mascot/Mascot";
import { ModelLogo } from "@/components/ModelLogo";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ThumbAction } from "@/components/ThumbAction";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { useResourceMemberships } from "@/hooks/useResourceMemberships";
import { applyChatOrder, useChatOrder } from "@/lib/chat-order";
import { haptic } from "@/lib/haptics";
import { modelDisplayName } from "@/lib/model-brand";
import { queryKeys } from "@/lib/queryKeys";
import { useRecentAgentChats } from "@/lib/recent-agent-chats";
import { Link } from "@/lib/router";
import { agentRouteRef, cn, relativeTime } from "@/lib/utils";

const STATUS_WORDS: Record<string, string> = {
  running: "Working now",
  active: "Ready",
  idle: "Ready",
  paused: "Paused",
  error: "Needs attention",
  pending_approval: "Waiting for approval",
};

const FEATURES = [
  { icon: ImagePlus, title: "Photos & files", hint: "Attach from your phone" },
  { icon: Sparkles, title: "Any model", hint: "Claude, GPT, DeepSeek…" },
  { icon: KeyRound, title: "Your own key", hint: "Bring your API key" },
];

function agentModel(agent: Agent): string {
  return typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
}

interface ChatRowProps {
  agent: Agent;
  pinned?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function ChatRow({ agent, pinned, onMoveUp, onMoveDown }: ChatRowProps) {
  const model = agentModel(agent);
  const live = agent.status === "running";
  const roleLabel = AGENT_ROLE_LABELS[agent.role as AgentRole] ?? agent.role;
  const RoleIcon = roleIcon(agent.role);
  return (
    <li className="flex items-center transition-colors hover:bg-accent/60">
      <Link
        to={`/chats/${agentRouteRef(agent)}`}
        onClick={() => haptic("tick")}
        data-slot="chat-row"
        className="flex min-h-16 min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 active:bg-accent"
      >
        <AgentStatusAvatar agent={agent} size={40} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{agent.name}</span>
            {pinned ? <Pin className="size-3 shrink-0 self-center fill-current text-primary" aria-label="Pinned" /> : null}
            <span className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
              <RoleIcon className="size-3 shrink-0 self-center" aria-hidden="true" />
              <span className="truncate">{agent.title || roleLabel}</span>
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {model ? <ModelLogo modelId={model} adapterType={agent.adapterType} size="xs" tile={false} /> : null}
            <span className="truncate font-medium text-foreground/80">{model ? modelDisplayName(model) : getAdapterLabel(agent.adapterType)}</span>
            <span aria-hidden="true">·</span>
            <span className={cn("shrink-0", live && "text-emerald-600 dark:text-emerald-400")}>
              {live ? STATUS_WORDS.running : agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : STATUS_WORDS[agent.status] ?? agent.status}
            </span>
          </span>
        </span>
      </Link>
      <span className="flex shrink-0 items-center pr-2 pl-1">
        <ChatOptionsMenu agent={agent} onMoveUp={onMoveUp} onMoveDown={onMoveDown} />
      </span>
    </li>
  );
}

/**
 * Chats: every agent you can talk to, one tap from a conversation. Each row
 * shows the agent's character, its model (with the maker's logo), and whether
 * it is working right now. Under the list, "Your API keys" connects the keys
 * the model switcher uses.
 */
export function Chats() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewAgent } = useDialogActions();
  const { enabled, loaded } = useAgentChatEnabled();
  const [query, setQuery] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Chats" }]);
  }, [setBreadcrumbs]);

  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const recentIds = useRecentAgentChats(selectedCompanyId ?? "", userId);
  const connections = useQuery({
    queryKey: ["ai-connections", selectedCompanyId],
    queryFn: () => aiConnectionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connected = useMemo(() => {
    const providers = new Set<AiProvider>();
    for (const connection of connections.data?.connections ?? []) {
      if (connection.status === "connected") providers.add(connection.provider);
    }
    return providers;
  }, [connections.data]);

  const chatAgents = useMemo(
    () => (agents.data ?? []).filter((agent) => agent.status !== "terminated"),
    [agents.data],
  );
  const memberships = useResourceMemberships(selectedCompanyId);
  const pinnedIds = memberships.data?.starredAgentIds;
  const { order, move } = useChatOrder(selectedCompanyId ?? "", userId);
  // Your order first (Move up / Move down), then the chats you opened most
  // recently, then everyone else by name.
  const ordered = useMemo(() => {
    const recentRank = new Map(recentIds.map((id, index) => [id, index]));
    const base = [...chatAgents].sort((a, b) => {
      const ra = recentRank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = recentRank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb || a.name.localeCompare(b.name);
    });
    return applyChatOrder(base, order);
  }, [chatAgents, recentIds, order]);
  const pinned = useMemo(() => ordered.filter((agent) => pinnedIds?.includes(agent.id)), [ordered, pinnedIds]);
  const others = useMemo(() => ordered.filter((agent) => !pinnedIds?.includes(agent.id)), [ordered, pinnedIds]);
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return ordered.filter((agent) => {
      const haystack = `${agent.name} ${agent.title ?? ""} ${modelDisplayName(agentModel(agent))} ${getAdapterLabel(agent.adapterType)}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [ordered, query]);
  const moveWithin = (list: Agent[], agent: Agent, direction: -1 | 1) => {
    haptic("tick");
    move(list.map((item) => item.id), agent.id, direction);
  };
  const rows = (list: Agent[], section: "pinned" | "all") =>
    list.map((agent, index) => (
      <ChatRow
        key={agent.id}
        agent={agent}
        pinned={section === "pinned"}
        onMoveUp={index > 0 ? () => moveWithin(list, agent, -1) : undefined}
        onMoveDown={index < list.length - 1 ? () => moveWithin(list, agent, 1) : undefined}
      />
    ));

  if (!selectedCompanyId || agents.isPending || !loaded) return <PageSkeleton variant="list" />;
  if (agents.error) return <p className="text-sm text-destructive">{agents.error.message}</p>;

  if (!enabled) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm">
        <p className="font-medium text-foreground">Agent Chat is turned off.</p>
        <p className="mt-1 text-muted-foreground">
          Turn it on in <Link to="/instance/settings/experimental" className="font-medium text-primary">Experimental settings</Link> to chat with your agents.
        </p>
      </div>
    );
  }

  if (chatAgents.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={MessagesSquare}
          title="No one to chat with yet"
          message="Hire your first agent, then chat with it here."
          action="Hire an agent"
          onAction={openNewAgent}
          steps={["Hire an agent and pick its model", "Tap it here to open a chat", "Send a message, a photo, or a file"]}
        />
        <ByokKeysCard connected={connected} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
        <Mascot pose="excited" size="sm" />
        <div className="min-w-0">
          <p className="font-display text-lg font-semibold leading-tight tracking-tight">Chat with your agents</p>
          <p className="mt-1 text-sm text-muted-foreground">Ask anything, hand off work, or send a photo. Switch models from the chat header.</p>
        </div>
      </div>

      <ul className="grid grid-cols-3 gap-2" aria-label="What you can do in a chat">
        {FEATURES.map(({ icon: Icon, title, hint }) => (
          <li key={title} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3">
            <Icon className="size-4 text-primary" aria-hidden="true" />
            <span className="text-xs font-semibold text-foreground">{title}</span>
            <span className="text-(length:--text-micro) leading-snug text-muted-foreground">{hint}</span>
          </li>
        ))}
      </ul>

      {pinned.length > 0 && !query ? (
        <section aria-labelledby="pinned-chats-heading" className="flex flex-col gap-2">
          <h2 id="pinned-chats-heading" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <Pin className="size-3.5" aria-hidden="true" />
            Pinned
          </h2>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">{rows(pinned, "pinned")}</ul>
        </section>
      ) : null}

      <section aria-labelledby="all-chats-heading" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 id="all-chats-heading" className="text-sm font-medium text-muted-foreground">
            {pinned.length > 0 && !query ? "Chats" : "All agents"} <span className="tabular-nums">· {query ? matches.length : others.length}</span>
          </h2>
          {!query ? <span className="text-xs text-muted-foreground">Tap ⋯ to pin, move, or delete</span> : null}
        </div>
        {chatAgents.length > 5 ? (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents or models" aria-label="Search agents" className="h-10 pl-9" />
          </div>
        ) : null}
        {query && matches.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {matches.map((agent) => <ChatRow key={agent.id} agent={agent} pinned={pinnedIds?.includes(agent.id)} />)}
          </ul>
        ) : !query && others.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">{rows(others, "all")}</ul>
        ) : !query ? (
          <p className="rounded-lg border border-border bg-card px-3 py-6 text-center text-sm text-muted-foreground">Every chat is pinned.</p>
        ) : (
          <p className="rounded-lg border border-border bg-card px-3 py-6 text-center text-sm text-muted-foreground">No agents match “{query}”.</p>
        )}
      </section>

      <ByokKeysCard connected={connected} />
      <ThumbAction label="Hire an agent" onClick={openNewAgent} />
    </div>
  );
}
