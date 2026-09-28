import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ImagePlus, KeyRound, MessagesSquare, Search, Sparkles } from "lucide-react";
import type { AiProvider, Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { aiConnectionsApi } from "@/api/ai-connections";
import { authApi } from "@/api/auth";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ByokKeysCard } from "@/components/agent-chat/ByokKeysCard";
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
import { haptic } from "@/lib/haptics";
import { modelDisplayName } from "@/lib/model-brand";
import { queryKeys } from "@/lib/queryKeys";
import { useRecentAgentChats } from "@/lib/recent-agent-chats";
import { Link } from "@/lib/router";
import { agentRouteRef, cn } from "@/lib/utils";

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

function ChatRow({ agent }: { agent: Agent }) {
  const model = agentModel(agent);
  const live = agent.status === "running";
  return (
    <li>
      <Link
        to={`/chats/${agentRouteRef(agent)}`}
        onClick={() => haptic("tick")}
        data-slot="chat-row"
        className="flex min-h-16 items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/60 active:bg-accent"
      >
        <span className="relative shrink-0">
          <AgentAvatar agent={agent} size={40} pose={live ? "working" : "rest"} />
          {live ? (
            <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-card bg-emerald-500" aria-hidden="true" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{agent.name}</span>
            {agent.title ? <span className="truncate text-xs text-muted-foreground">{agent.title}</span> : null}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {model ? <ModelLogo modelId={model} adapterType={agent.adapterType} size="xs" tile={false} /> : null}
            <span className="truncate font-medium text-foreground/80">{model ? modelDisplayName(model) : getAdapterLabel(agent.adapterType)}</span>
            <span aria-hidden="true">·</span>
            <span className={cn("shrink-0", live && "text-emerald-600 dark:text-emerald-400")}>
              {STATUS_WORDS[agent.status] ?? agent.status}
            </span>
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
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
  const recent = useMemo(
    () => recentIds.flatMap((id) => chatAgents.filter((agent) => agent.id === id)).slice(0, 3),
    [recentIds, chatAgents],
  );
  const everyone = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return [...chatAgents]
      .filter((agent) => {
        const haystack = `${agent.name} ${agent.title ?? ""} ${modelDisplayName(agentModel(agent))} ${getAdapterLabel(agent.adapterType)}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.name.localeCompare(b.name));
  }, [chatAgents, query]);

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

      {recent.length > 0 && !query ? (
        <section aria-labelledby="recent-chats-heading" className="flex flex-col gap-2">
          <h2 id="recent-chats-heading" className="text-sm font-medium text-muted-foreground">Recent</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {recent.map((agent) => <ChatRow key={agent.id} agent={agent} />)}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="all-chats-heading" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 id="all-chats-heading" className="text-sm font-medium text-muted-foreground">
            All agents <span className="tabular-nums">· {chatAgents.length}</span>
          </h2>
        </div>
        {chatAgents.length > 5 ? (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents or models" aria-label="Search agents" className="h-10 pl-9" />
          </div>
        ) : null}
        {everyone.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {everyone.map((agent) => <ChatRow key={agent.id} agent={agent} />)}
          </ul>
        ) : (
          <p className="rounded-lg border border-border bg-card px-3 py-6 text-center text-sm text-muted-foreground">No agents match “{query}”.</p>
        )}
      </section>

      <ByokKeysCard connected={connected} />
      <ThumbAction label="Hire an agent" onClick={openNewAgent} />
    </div>
  );
}
