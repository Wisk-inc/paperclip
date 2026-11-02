// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { NeedsYouList } from "./NeedsYouList";

const badge = vi.hoisted(() => ({ inbox: 0, approvals: 0 }));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxBadge: () => badge }));
vi.mock("../hooks/useDeviceFilesBadge", () => ({ useDeviceFilesBadge: () => ({ pendingRequests: 0 }) }));
vi.mock("../hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: [] }) }));
vi.mock("../hooks/useAccountProfile", () => ({ useAccountProfile: () => ({ firstName: "Ada" }) }));
vi.mock("../api/auth", () => ({ authApi: { getSession: vi.fn(async () => null) } }));
vi.mock("./account/AccountSheet", () => ({ AccountButton: () => null }));
vi.mock("./mascot/Mascot", () => ({ Mascot: () => null }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "ACME" }, companies: [] }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("NeedsYouList", () => {
  it("counts each pending approval once, though the inbox also lists it", async () => {
    // One budget stop: it is the inbox's one item and the one pending approval.
    badge.inbox = 1;
    badge.approvals = 1;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>
            <NeedsYouList companyId="company-1" pendingApprovals={1} />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    expect(container.textContent).toContain("1 thing needs you.");
    await act(async () => root.unmount());
    container.remove();
  });
});
