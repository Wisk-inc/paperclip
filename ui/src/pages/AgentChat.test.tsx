// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChat } from "./AgentChat";

const mocks = vi.hoisted(() => ({
  agentsList: vi.fn(),
  chatGet: vi.fn(),
  chatEnsure: vi.fn(),
  getSession: vi.fn(),
  getExperimental: vi.fn(),
  surface: vi.fn(),
  agentRef: "robin",
}));

vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.agentsList } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { get: mocks.chatGet, ensure: mocks.chatEnsure } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: mocks.getSession } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mocks.getExperimental } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/recent-agent-chats", () => ({ recordAgentChatVisit: vi.fn() }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
  useParams: () => ({ agentRef: mocks.agentRef }),
}));
vi.mock("./IssueDetail", () => ({
  TaskDetailSurface: (props: unknown) => {
    mocks.surface(props);
    return <div data-testid="chat-surface" />;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function agent(status: string) {
  return { id: "agent-robin", companyId: "company-1", name: "Robin", urlKey: "robin", status, adapterType: "claude_local" };
}

let root: Root;
let container: HTMLDivElement;

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><AgentChat /></QueryClientProvider>);
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("AgentChat", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of [mocks.agentsList, mocks.chatGet, mocks.chatEnsure, mocks.getSession, mocks.getExperimental, mocks.surface]) fn.mockReset();
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { userId: "user-1" } });
    mocks.getExperimental.mockResolvedValue({ enableAgentChat: true });
    mocks.chatGet.mockResolvedValue(null);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens the chat composer for an agent that can take work", async () => {
    mocks.agentsList.mockResolvedValue([agent("idle")]);
    await render();
    expect(container.querySelector("[data-testid=chat-surface]")).not.toBeNull();
  });

  it("explains a hire awaiting approval instead of offering a composer that would fail", async () => {
    mocks.agentsList.mockResolvedValue([agent("pending_approval")]);
    await render();
    expect(container.querySelector("[data-testid=chat-surface]")).toBeNull();
    const notice = container.querySelector("[data-testid=agent-chat-unavailable]");
    expect(notice?.textContent).toContain("Robin is waiting for its hire to be approved");
    expect(notice?.querySelector("a")?.getAttribute("href")).toBe("/approvals");
    expect(mocks.chatEnsure).not.toHaveBeenCalled();
  });

  it("still opens an existing chat with a terminated agent (its history)", async () => {
    mocks.agentsList.mockResolvedValue([agent("terminated")]);
    mocks.chatGet.mockResolvedValue({ id: "chat-1", companyId: "company-1", conversationAgentId: "agent-robin" });
    await render();
    expect(container.querySelector("[data-testid=chat-surface]")).not.toBeNull();
  });

  it("says Agent Chat couldn't be checked (with Try again) when the setting fails to load", async () => {
    mocks.agentsList.mockResolvedValue([agent("idle")]);
    mocks.getExperimental.mockRejectedValueOnce(new Error("Server unreachable"));
    await render();
    const failed = container.querySelector("[data-testid=agent-chat-setting-failed]");
    expect(failed?.textContent).toContain("Couldn't check whether Agent Chat is on");
    expect(container.textContent).not.toContain("Agent Chat is disabled");

    mocks.getExperimental.mockResolvedValue({ enableAgentChat: true });
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => retry.click());
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
    expect(container.querySelector("[data-testid=chat-surface]")).not.toBeNull();
  });
});
