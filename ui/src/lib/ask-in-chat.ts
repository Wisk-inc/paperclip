import { isAgentStatusInvokable, type Agent } from "@paperclipai/shared";
import { loadDraft, saveDraft } from "./composer-draft";
import { agentRouteRef } from "./utils";

/** The composer's draft key for one person's chat with one agent (see IssueDetail). */
export function agentChatDraftKey(companyId: string, userId: string, agentId: string): string {
  return `paperclip:agent-chat-draft:${companyId}:${userId}:${agentId}`;
}

/**
 * The agent to hand a question to: one that can be invoked (not offboarded or
 * awaiting approval), a Claude one when there is one (the App Inspector's
 * Explain already uses Claude), else the first.
 */
export function pickChatAgent(agents: Agent[]): Agent | null {
  const open = agents.filter((agent) => isAgentStatusInvokable(agent.status));
  return open.find((agent) => /claude|anthropic/i.test(agent.adapterType ?? "")) ?? open[0] ?? null;
}

/**
 * Opens a chat with an agent with a question already typed, so the person
 * only has to press Send. The question goes after anything already typed in
 * that chat, in the composer's own storage; the chat page picks it up when it
 * mounts. Returns false when the question could not be stored (the composer
 * refuses writes while that chat still has a send in flight).
 */
export function openChatWithDraft(
  navigate: (to: string) => void,
  input: { companyId: string; userId: string; agent: Agent; text: string },
): boolean {
  const key = agentChatDraftKey(input.companyId, input.userId, input.agent.id);
  const existing = loadDraft(key).trim();
  const text = existing ? `${existing}\n\n${input.text}` : input.text;
  saveDraft(key, text);
  const stored = loadDraft(key) === text;
  navigate(`/chats/${agentRouteRef(input.agent)}`);
  return stored;
}
