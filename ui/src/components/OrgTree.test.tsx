// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Agent } from "@paperclipai/shared";
import type { OrgNode } from "@/api/agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgTree } from "./OrgTree";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/components/agent-chat/AgentChatHeader", () => ({
  AgentStatusAvatar: () => <span />,
  EditAgentButton: () => <button type="button">Edit</button>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agents = [
  { id: "a-lead", companyId: "c1", name: "Lead", urlKey: "lead", role: "ceo", status: "idle", adapterType: "process", adapterConfig: {} },
  { id: "a-new", companyId: "c1", name: "Newbie", urlKey: "newbie", role: "engineer", status: "pending_approval", adapterType: "process", adapterConfig: {} },
] as unknown as Agent[];
const orgTree = [
  { id: "a-lead", name: "Lead", role: "ceo", status: "idle", reports: [{ id: "a-new", name: "Newbie", role: "engineer", status: "pending_approval", reports: [] }] },
] as unknown as OrgNode[];

let root: Root;
let container: HTMLDivElement;

function hrefOf(name: string) {
  const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent?.includes(name));
  return link?.getAttribute("href");
}

describe("OrgTree", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens an agent's chat when Agent Chat is on", async () => {
    await act(async () => root.render(<OrgTree orgTree={orgTree} agents={agents} chatEnabled />));
    expect(hrefOf("Lead")).toBe("/chats/lead");
    // A hire awaiting approval can't chat yet: its page instead.
    expect(hrefOf("Newbie")).toBe("/agents/newbie");
  });

  it("opens the agent's page, not a chat that is switched off", async () => {
    await act(async () => root.render(<OrgTree orgTree={orgTree} agents={agents} chatEnabled={false} />));
    expect(hrefOf("Lead")).toBe("/agents/lead");
    expect(hrefOf("Newbie")).toBe("/agents/newbie");
  });
});
