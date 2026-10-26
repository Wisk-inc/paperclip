import type { Agent } from "@paperclipai/shared";
import { saveDraft } from "./composer-draft";
import { agentRouteRef } from "./utils";

/** The composer's draft key for one person's chat with one agent (see IssueDetail). */
export function agentChatDraftKey(companyId: string, userId: string, agentId: string): string {
  return `paperclip:agent-chat-draft:${companyId}:${userId}:${agentId}`;
}

/**
 * The agent to hand a question to: a Claude one when there is one (the App
 * Inspector's Explain already uses Claude), else the first.
 */
export function pickChatAgent(agents: Agent[]): Agent | null {
  return agents.find((agent) => /claude|anthropic/i.test(agent.adapterType ?? "")) ?? agents[0] ?? null;
}

/**
 * Opens a chat with an agent with a question already typed, so the person
 * only has to press Send. The draft lives in the composer's own storage; the
 * chat page picks it up when it mounts.
 */
export function openChatWithDraft(
  navigate: (to: string) => void,
  input: { companyId: string; userId: string; agent: Agent; text: string },
): void {
  saveDraft(agentChatDraftKey(input.companyId, input.userId, input.agent.id), input.text);
  navigate(`/chats/${agentRouteRef(input.agent)}`);
}
