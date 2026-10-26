// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { agentChatDraftKey, openChatWithDraft, pickChatAgent } from "./ask-in-chat";
import { loadDraft, saveDraft, saveDraftSubmission } from "./composer-draft";

// Only the fields the helper reads matter here.
function agent(overrides: Partial<Agent> = {}): Agent {
  return { id: "a1", companyId: "c1", name: "Ada", adapterType: "codex_local", urlKey: "ada", status: "active", ...overrides } as unknown as Agent;
}

describe("ask in chat", () => {
  afterEach(() => sessionStorage.clear());

  it("prefers a Claude agent, else the first one", () => {
    const codex = agent({ id: "codex", adapterType: "codex_local" } as Partial<Agent>);
    const claude = agent({ id: "claude", adapterType: "claude_local" } as Partial<Agent>);
    const api = agent({ id: "api", adapterType: "anthropic_api" } as Partial<Agent>);
    expect(pickChatAgent([codex, claude])?.id).toBe("claude");
    expect(pickChatAgent([codex, api])?.id).toBe("api");
    expect(pickChatAgent([codex])?.id).toBe("codex");
    expect(pickChatAgent([])).toBeNull();
  });

  it("skips agents that can't be invoked, such as offboarded ones", () => {
    const gone = agent({ id: "gone", adapterType: "claude_local", status: "terminated" } as Partial<Agent>);
    const waiting = agent({ id: "waiting", adapterType: "claude_local", status: "pending_approval" } as Partial<Agent>);
    const codex = agent({ id: "codex", adapterType: "codex_local", status: "idle" } as Partial<Agent>);
    expect(pickChatAgent([gone, waiting, codex])?.id).toBe("codex");
    expect(pickChatAgent([gone])).toBeNull();
  });

  it("writes the question where the chat composer looks, then opens that chat", () => {
    const navigate = vi.fn();
    const ada = agent();
    expect(openChatWithDraft(navigate, { companyId: "c1", userId: "u1", agent: ada, text: "What does this app do?" })).toBe(true);
    expect(loadDraft(agentChatDraftKey("c1", "u1", "a1"))).toBe("What does this app do?");
    expect(navigate).toHaveBeenCalledWith("/chats/ada");
  });

  it("keeps what was already typed in that chat and adds the question after it", () => {
    const key = agentChatDraftKey("c1", "u1", "a1");
    saveDraft(key, "Half a thought ");
    expect(openChatWithDraft(vi.fn(), { companyId: "c1", userId: "u1", agent: agent(), text: "And a question?" })).toBe(true);
    expect(loadDraft(key)).toBe("Half a thought\n\nAnd a question?");
  });

  it("says so when the chat is mid-send and refuses the draft", () => {
    const key = agentChatDraftKey("c1", "u1", "a1");
    saveDraftSubmission(key, { attemptId: "0f9c2e4a-6b1d-4c3e-9a7f-2d5b8e1c4a6f", reviewed: false });
    const navigate = vi.fn();
    expect(openChatWithDraft(navigate, { companyId: "c1", userId: "u1", agent: agent(), text: "Question?" })).toBe(false);
    expect(loadDraft(key)).toBe("");
    expect(navigate).toHaveBeenCalledWith("/chats/ada");
  });
});
