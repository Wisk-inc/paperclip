import { ImagePlus, KeyRound, MessageCircleQuestion, Sparkles, type LucideIcon } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { aiProviderForAdapter } from "@/components/ai-connections/AiConnectionField";
import { Link } from "@/lib/router";
import { AgentModelButton } from "./AgentModelButton";
import { connectKeyHref } from "./ByokKeysCard";

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
 * The first screen of a new chat: the agent's character, who it is, the model
 * it runs on (tap to switch), and what a chat can do. It replaces a bare
 * "No messages yet" so the screen is never an empty void above the composer.
 */
export function ChatWelcome({ agent }: { agent: Agent }) {
  const role = agent.title || AGENT_ROLE_LABELS[agent.role as keyof typeof AGENT_ROLE_LABELS] || null;
  const keyProvider = aiProviderForAdapter(agent.adapterType) ?? "openrouter";
  return (
    <div data-slot="chat-welcome" className="mx-auto flex w-full max-w-md flex-col items-center gap-4 px-4 pt-4 pb-6 text-center text-foreground">
      <div className="mascot-float">
        <AgentAvatar agent={agent} size={96} pose="listening" label={`${agent.name}'s character`} />
      </div>
      <div className="flex flex-col items-center gap-1">
        <p className="font-display text-xl font-semibold tracking-tight">Chat with {agent.name}</p>
        {role ? <p className="text-sm text-muted-foreground">{role}</p> : null}
      </div>
      <AgentModelButton agent={agent} />
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
