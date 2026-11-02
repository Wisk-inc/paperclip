// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalDetail } from "./ApprovalDetail";

const approvalsApi = vi.hoisted(() => ({
  get: vi.fn(),
  listComments: vi.fn(async () => []),
  listIssues: vi.fn(async () => []),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  addComment: vi.fn(),
}));
vi.mock("../api/approvals", () => ({ approvalsApi }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status: "pending",
    payload: { name: "Designer" },
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    decidedByUserId: null,
    decisionNote: null,
    createdAt: "2026-10-30T12:00:00.000Z",
    updatedAt: "2026-10-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("ApprovalDetail", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  async function render(path = "/approvals/approval-1") {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/approvals/:approvalId" element={<ApprovalDetail />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flush();
    return root;
  }

  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);

  it("asks what should change and sends that note with the revision request", async () => {
    approvalsApi.get.mockResolvedValue(approval());
    approvalsApi.requestRevision.mockResolvedValue(approval({ status: "revision_requested" }));
    const root = await render();

    await act(async () => button("Request revision")!.click());
    const note = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="What should change"]');
    expect(note).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(note, "Use a cheaper model");
      note!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send back")!.click());
    await flush();

    expect(approvalsApi.requestRevision).toHaveBeenCalledWith("approval-1", "Use a cheaper model");
    await act(async () => root.unmount());
  });

  it("offers no revision on a budget stop, and says an agent was notified only when one asked", async () => {
    approvalsApi.get.mockResolvedValue(approval({ type: "budget_override_required", requestedByAgentId: null, payload: {} }));
    let root = await render();
    expect(button("Request revision")).toBeUndefined();
    await act(async () => root.unmount());

    approvalsApi.get.mockResolvedValue(approval({ status: "approved", requestedByAgentId: null }));
    root = await render("/approvals/approval-1?resolved=approved");
    expect(container.textContent).toContain("Approval confirmed");
    expect(container.textContent).not.toContain("Requesting agent was notified");
    await act(async () => root.unmount());
  });
});
