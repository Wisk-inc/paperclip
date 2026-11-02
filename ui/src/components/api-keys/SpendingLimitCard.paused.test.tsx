// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendingLimitCard } from "./SpendingLimitCard";

const mocks = vi.hoisted(() => ({ overview: vi.fn(), upsertPolicy: vi.fn(), pushToast: vi.fn() }));
vi.mock("@/api/budgets", () => ({ budgetsApi: { overview: mocks.overview, upsertPolicy: mocks.upsertPolicy } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mocks.pushToast }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function companyPolicy(overrides: Record<string, unknown>) {
  return {
    policyId: "p1",
    scopeType: "company",
    scopeId: "c1",
    windowKind: "calendar_month_utc",
    isActive: true,
    amount: 2000,
    observedAmount: 0,
    remainingAmount: 2000,
    status: "ok",
    paused: false,
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><SpendingLimitCard companyId="c1" /></QueryClientProvider>));
  for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("SpendingLimitCard", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.upsertPolicy.mockReset().mockResolvedValue({});
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says a new month didn't resume a paused organization, and resumes it on a tap", async () => {
    // Last month's stop: this month nothing is spent, but the organization is still paused.
    mocks.overview.mockResolvedValue({ policies: [companyPolicy({ paused: true, observedAmount: 0, status: "ok" })] });
    await render();
    expect(container.textContent).toContain("Still paused since the limit was reached");
    expect(container.textContent).not.toContain("nothing overspends");
    await act(async () => container.querySelector<HTMLButtonElement>("[data-testid=spending-limit-resume]")!.click());
    expect(mocks.upsertPolicy).toHaveBeenCalledWith("c1", expect.objectContaining({ scopeType: "company", amount: 2000 }));
  });

  it("offers no Resume while the limit is reached this month (raising it is the way on)", async () => {
    mocks.overview.mockResolvedValue({ policies: [companyPolicy({ paused: true, observedAmount: 2100, status: "hard_stop" })] });
    await render();
    expect(container.textContent).toContain("Limit reached");
    expect(container.querySelector("[data-testid=spending-limit-resume]")).toBeNull();
  });
});
