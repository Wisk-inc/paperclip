import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ImagePlus, KeyRound, MessageCircleQuestion, Sparkles, type LucideIcon } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent, type AgentRole } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { AgentAvatar } from "@/components/AgentAvatar";
import { aiProviderForAdapter } from "@/components/ai-connections/AiConnectionField";
import { insertIntoComposer } from "@/lib/composer-insert";
import { haptic } from "@/lib/haptics";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, relativeTime } from "@/lib/utils";
import { agentStatusLabel, EditAgentButton } from "./AgentChatHeader";
import { AgentModelButton } from "./AgentModelButton";
import { connectKeyHref } from "./ByokKeysCard";
import { ROLE_PROMPTS, roleIcon } from "./role-icons";

function Tip({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="text-sm leading-snug text-muted-foreground">{children}</span>
    </li>
  );
}

/**
 * The first screen of a new chat: the agent's character and status, who it
 * is (role, title, manager), the model it runs on (tap to switch),
 * conversation starters for its role, and what a chat can do. It replaces a
 * bare "No messages yet" so the screen is never an empty void above the
 * composer.
 */
export function ChatWelcome({ agent }: { agent: Agent }) {
  const roleLabel = AGENT_ROLE_LABELS[agent.role as AgentRole] ?? agent.role;
  const RoleIcon = roleIcon(agent.role);
  const keyProvider = aiProviderForAdapter(agent.adapterType) ?? "openrouter";
  const prompts = ROLE_PROMPTS[agent.role as AgentRole] ?? ROLE_PROMPTS.general ?? [];
  const agents = useQuery({
    queryKey: queryKeys.agents.list(agent.companyId),
    queryFn: () => agentsApi.list(agent.companyId),
  });
  const manager = agent.reportsTo ? agents.data?.find((item) => item.id === agent.reportsTo) : null;
  const live = agent.status === "running";
  const lastActive = agent.lastHeartbeatAt ? `active ${relativeTime(agent.lastHeartbeatAt)}` : "not started yet";

  return (
    <div data-slot="chat-welcome" className="mx-auto flex w-full max-w-md flex-col items-center gap-4 px-4 pt-4 pb-6 text-center text-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300">
      <div className="relative mascot-float">
        <AgentAvatar agent={agent} size={96} pose={live ? "working" : "listening"} label={`${agent.name}'s character`} />
        <span
          className={cn(
            "absolute right-2 bottom-3 size-4 rounded-full border-4 border-background",
            live ? "bg-emerald-500 motion-safe:animate-pulse" : agent.status === "error" ? "bg-red-500" : agent.status === "paused" ? "bg-amber-500" : "bg-emerald-500",
          )}
          aria-hidden="true"
        />
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <p className="font-display text-xl font-semibold tracking-tight">Chat with {agent.name}</p>
        <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs">
          <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card px-2 font-medium text-foreground">
            <RoleIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {roleLabel}
          </span>
          {agent.title && agent.title !== roleLabel ? (
            <span className="inline-flex h-6 items-center rounded-full border border-border bg-card px-2 text-muted-foreground">{agent.title}</span>
          ) : null}
          {manager ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card pr-2 pl-0.5 text-muted-foreground">
              <AgentAvatar agent={manager} size={20} />
              Reports to {manager.name}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          <span className={cn("font-medium", live ? "text-emerald-600 dark:text-emerald-400" : "text-foreground/80")}>{agentStatusLabel(agent.status)}</span>
          {" · "}
          {lastActive}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <AgentModelButton agent={agent} />
        <EditAgentButton agent={agent} variant="pill" />
      </div>

      {prompts.length > 0 ? (
        <section aria-label="Try asking" className="w-full text-left">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Try asking</h3>
          <div className="flex flex-col gap-2">
            {prompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                data-slot="chat-starter"
                onClick={() => {
                  haptic("tick");
                  insertIntoComposer(prompt);
                }}
                className="group flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-foreground transition-(--tp-transform-opacity) hover:bg-accent/60 active:scale-98 motion-reduce:active:scale-100"
              >
                <span className="min-w-0 flex-1">{prompt}</span>
                <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <ul className="grid w-full gap-2 text-left" aria-label="What you can do here">
        <Tip icon={ImagePlus}>
          <span className="font-medium text-foreground">Send photos and files.</span> Tap + under the message box to attach photos, screenshots, PDFs, or any file.
        </Tip>
        <Tip icon={Sparkles}>
          <span className="font-medium text-foreground">Switch models anytime.</span> Tap the model above: Claude, GPT, Gemini, DeepSeek, Llama, Qwen, and more.
        </Tip>
        <Tip icon={MessageCircleQuestion}>
          <span className="font-medium text-foreground">Ask, plan, or hand off.</span> Pick a mode under the message box: Ask just answers, Plan proposes a plan for you to approve, Auto lets {agent.name} start the work.
        </Tip>
        <Tip icon={KeyRound}>
          <span className="font-medium text-foreground">Use your own API key.</span>{" "}
          <Link to={connectKeyHref(keyProvider)} className="font-medium text-primary">Add a key</Link> so {agent.name} runs on your account.
        </Tip>
      </ul>
    </div>
  );
}
