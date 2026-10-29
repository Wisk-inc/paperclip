// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/context/ThemeContext";
import { issuesApi } from "@/api/issues";
import { TaskChatThread } from "./TaskChatThread";

const toastActions = vi.hoisted(() => ({ pushToast: vi.fn() }));
const pushToast = toastActions.pushToast;
const actionRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/components/task-chat/TaskChatBubbleActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/task-chat/TaskChatBubbleActions")>();
  return {
    ...actual,
    TaskChatBubbleActions: (props: Parameters<typeof actual.TaskChatBubbleActions>[0]) => {
      actionRenders.count += 1;
      return <actual.TaskChatBubbleActions {...props} />;
    },
  };
});

vi.mock("@/context/ToastContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/context/ToastContext")>()),
  useOptionalToastActions: () => toastActions,
}));
vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), isInitialHydrating: false, hydratedRunIds: undefined }),
}));
vi.mock("@/components/transcript/useNativeRunTranscripts", () => ({
  useNativeRunTranscripts: () => ({ transcriptByRun: new Map(), errorsByRun: new Map(), hydratedRunIds: undefined }),
}));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: true }) }));
vi.mock("@/hooks/useIssuePlanDocument", () => ({ useIssuePlanDocument: () => ({ data: null }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor({ value }: { value: string }, ref: ForwardedRef<unknown>) {
    useImperativeHandle(ref, () => ({ insertMarkdown: () => {}, focus: () => {} }));
    return <div data-testid="mock-editor">{value}</div>;
  }),
}));

const base = { companyId: "company", issueId: "issue", presentation: null, metadata: null };
const comments = [
  {
    ...base,
    id: "ask",
    authorType: "user" as const,
    authorUserId: "board",
    authorAgentId: null,
    body: "Draw a fishing boat at sunset",
    createdAt: new Date("2026-10-28T12:00:00Z"),
    updatedAt: new Date("2026-10-28T12:00:00Z"),
  },
  {
    ...base,
    id: "reply",
    authorType: "agent" as const,
    authorUserId: null,
    authorAgentId: "agent-1",
    body: "Here is your boat.",
    createdAt: new Date("2026-10-28T12:00:05Z"),
    updatedAt: new Date("2026-10-28T12:00:05Z"),
  },
];

describe("TaskChatThread asking again", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    pushToast.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
  });

  it("leaves settled replies alone when the thread is rebuilt, as it is many times a second while a reply streams", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const draw = () =>
      flushSync(() =>
        root!.render(
          <QueryClientProvider client={client}>
            <ThemeProvider>
              <TaskChatThread issueId="issue" comments={comments} onAdd={async () => {}} conversationMode />
            </ThemeProvider>
          </QueryClientProvider>,
        ),
      );
    draw();
    expect(container.querySelector('[data-testid="task-chat-retry"]')).not.toBeNull();
    const settled = actionRenders.count;
    for (let tick = 0; tick < 5; tick += 1) draw();
    expect(actionRenders.count).toBe(settled);
  });

  it("says so when Retry could not send the question again", async () => {
    vi.spyOn(issuesApi, "addComment").mockRejectedValue(new Error("Server unreachable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    flushSync(() =>
      root!.render(
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <TaskChatThread issueId="issue" comments={comments} onAdd={async () => {}} conversationMode />
          </ThemeProvider>
        </QueryClientProvider>,
      ),
    );
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-retry"]');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(issuesApi.addComment).toHaveBeenCalledWith("issue", "Draw a fishing boat at sunset", undefined, undefined, undefined, expect.any(String));
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn’t send that", body: "Server unreachable", tone: "error" }));
    expect(retry!.disabled).toBe(false);
  });
});
