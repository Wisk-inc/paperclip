import type { Agent, Issue, IssueWorkMode } from "@paperclipai/shared";
/** The placeholder id of a chat that has not started yet (see agentChatDraft). */
export function isDraftChatId(issueId: string): boolean {
  return issueId.startsWith("chat:");
}

/** Ephemeral view model; never persisted until first send or upload. */
export function agentChatDraft(
  agent: Agent,
  workMode: IssueWorkMode = "standard",
): Issue {
  return {
    id: `chat:${agent.id}`,
    companyId: agent.companyId,
    title: `Chat with ${agent.name}`,
    conversationAgentId: agent.id,
    conversationUserId: "draft",
    conversationState: "waiting",
    status: "in_review",
    workMode,
    priority: "medium",
    reviewPolicy: null,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    description: null,
    assigneeAgentId: agent.id,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    documentSummaries: [],
    labels: [],
  };
}

/**
 * Whether a new chat can start with this agent. The server assigns a chat to
 * its agent, which it refuses for an agent still awaiting hire approval or
 * one that was terminated (an existing chat with it still opens).
 */
export function canStartAgentChat(agent: Pick<Agent, "status">): boolean {
  return agent.status !== "pending_approval" && agent.status !== "terminated";
}
