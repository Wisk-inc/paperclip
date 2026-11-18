// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { UI_STRINGS } from "@paperclipai/shared/ui-strings.generated";
import { LiveTranslator } from "../i18n/live-translator";
import { buildUiStringIndex } from "../i18n/ui-string-index";
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

  it("greets and counts in whole sentences the on-screen translator finds, with the name and count kept", async () => {
    badge.inbox = 6;
    badge.approvals = 0;
    const hours = vi.spyOn(Date.prototype, "getHours").mockReturnValue(9);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>
            <NeedsYouList companyId="company-1" pendingApprovals={0} />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    expect(container.textContent).toContain("Good morning, Ada");
    expect(container.textContent).toContain("6 things need you. Start at the top.");
    // The board's real list of its own sentences, and Spanish for these two.
    const spanish: Record<string, string> = {
      "Good morning, {0}": "Buenos días, {0}",
      "{0} things need you. Start at the top.": "{0} cosas te necesitan. Empieza por arriba.",
    };
    const translator = new LiveTranslator({ root: container, index: buildUiStringIndex(UI_STRINGS), lookup: (source) => spanish[source] });
    translator.start();
    expect(container.textContent).toContain("Buenos días, Ada");
    expect(container.textContent).toContain("6 cosas te necesitan. Empieza por arriba.");
    translator.stop();
    hours.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  });
});
