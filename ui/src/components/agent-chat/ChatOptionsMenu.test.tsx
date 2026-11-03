// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { ChatOptionsMenu } from "./ChatOptionsMenu";

const remove = vi.hoisted(() => vi.fn(async (_id: string) => ({})));
const getChat = vi.hoisted(() => vi.fn(async (): Promise<{ id: string } | null> => null));
vi.mock("@/api/issues", () => ({ issuesApi: { remove } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { get: getChat } }));
vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
  useOptionalToastActions: () => ({ pushToast: vi.fn() }),
}));
vi.mock("@/hooks/useResourceMemberships", () => ({
  useResourceMemberships: () => ({ data: { starredAgentIds: [] } }),
  useResourceMembershipMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));
vi.mock("./EditAgentSheet", () => ({ EditAgentSheet: () => null }));
vi.mock("./AgentTerminalSheet", () => ({ AgentTerminalSheet: () => null }));
vi.mock("./RemoveAgentDialog", () => ({ RemoveAgentDialog: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agent = { id: "a1", companyId: "c1", name: "Atlas", role: "engineer", status: "running", adapterType: "free_models", adapterConfig: {} } as unknown as Agent;
const CHAT_ID = "11111111-1111-4111-8111-111111111111";

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  remove.mockClear();
  getChat.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(props: { chatIssueId?: string; afterDelete?: () => void }) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChatOptionsMenu agent={agent} chatIssueId={props.chatIssueId} afterDelete={props.afterDelete} />
      </QueryClientProvider>,
    );
  });
}

/** Opens the menu, picks Delete chat and confirms it. */
async function deleteThroughTheMenu() {
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="chat-options"]')!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((element) => element.textContent?.includes("Delete chat"))!;
  expect(item).toBeTruthy();
  await act(async () => {
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  const confirm = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Delete chat")!;
  expect(confirm).toBeTruthy();
  await act(async () => {
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  await flush();
}

describe("ChatOptionsMenu: Delete chat", () => {
  it("leaves the chat first, drops the deleted chat's queries and refreshes the lists", async () => {
    const detailFetches = vi.fn(async () => ({ id: CHAT_ID }));
    const listFetches = vi.fn(async () => []);
    // What the open chat page keeps live while the reply streams.
    await client.prefetchQuery({ queryKey: queryKeys.issues.detail(CHAT_ID), queryFn: detailFetches });
    await client.prefetchQuery({ queryKey: queryKeys.issues.liveRuns(CHAT_ID), queryFn: async () => [] });
    await client.prefetchQuery({ queryKey: queryKeys.issues.comments(CHAT_ID), queryFn: async () => [] });
    await client.prefetchQuery({ queryKey: ["agent-chat", "c1", null, "a1"], queryFn: async () => ({ id: CHAT_ID }) });
    await client.prefetchQuery({ queryKey: queryKeys.issues.list("c1"), queryFn: listFetches });
    const order: string[] = [];
    remove.mockImplementation(async () => { order.push("removed"); return {}; });
    const afterDelete = vi.fn(() => { order.push("left"); });
    detailFetches.mockClear();
    listFetches.mockClear();

    await render({ chatIssueId: CHAT_ID, afterDelete });
    await deleteThroughTheMenu();

    expect(remove).toHaveBeenCalledWith(CHAT_ID);
    expect(order).toEqual(["removed", "left"]);
    // The deleted chat is gone from the cache, never fetched again.
    expect(client.getQueryCache().find({ queryKey: queryKeys.issues.detail(CHAT_ID) })).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: queryKeys.issues.liveRuns(CHAT_ID) })).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: queryKeys.issues.comments(CHAT_ID) })).toBeUndefined();
    expect(detailFetches).not.toHaveBeenCalled();
    // The lists (chats, tasks) are marked for a refresh.
    expect(client.getQueryState(["agent-chat", "c1", null, "a1"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.issues.list("c1"))?.isInvalidated).toBe(true);
  });

  it("asks the server which chat exists instead of deleting a placeholder id", async () => {
    getChat.mockResolvedValueOnce({ id: CHAT_ID });
    await render({ chatIssueId: "chat:a1" });
    await deleteThroughTheMenu();
    expect(getChat).toHaveBeenCalledWith("c1", "a1");
    expect(remove).toHaveBeenCalledWith(CHAT_ID);
  });

  it("explains when there is no chat to delete yet", async () => {
    getChat.mockResolvedValueOnce(null);
    const afterDelete = vi.fn();
    await render({ chatIssueId: "chat:a1", afterDelete });
    await deleteThroughTheMenu();
    expect(remove).not.toHaveBeenCalled();
    expect(afterDelete).not.toHaveBeenCalled();
  });
});
