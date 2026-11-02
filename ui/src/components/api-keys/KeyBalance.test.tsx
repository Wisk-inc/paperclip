// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyBalance } from "./KeyBalance";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ balance: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));

const connection = {
  id: "conn-1",
  grantId: "grant-1",
  companyId: "company-1",
  provider: "anthropic",
  method: "api_key",
  name: "Claude key ··abcd",
  ownership: "personal",
  isDefault: true,
  status: "connected",
} as AiManagedConnectionSummary;

let root: Root;
let host: HTMLDivElement;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
});

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <KeyBalance companyId="company-1" connection={connection} providerLabel="Anthropic" />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).not.toContain("Checking the balance"));
}

describe("KeyBalance", () => {
  it("shows the month's spend as the provider's across all keys, and why there is no balance", async () => {
    api.balance.mockResolvedValue({
      connectionId: "conn-1",
      provider: "anthropic",
      remainingUsd: null,
      totalCreditsUsd: null,
      spentThisMonthCents: 320,
      billingUrl: "https://console.anthropic.com/settings/billing",
      note: "This provider doesn't share the balance with apps. See it in its console.",
      checkedAt: "2026-11-01T12:00:00.000Z",
    });
    await mount();
    expect(host.textContent).toContain("Anthropic use this month, all keys: $3.20");
    expect(host.querySelector("[data-testid=api-key-balance-note]")?.textContent).toBe(
      "This provider doesn't share the balance with apps. See it in its console.",
    );
  });

  it("shows what is left when the provider reports it, with no note", async () => {
    api.balance.mockResolvedValue({
      connectionId: "conn-1",
      provider: "openrouter",
      remainingUsd: 17.5,
      totalCreditsUsd: 25,
      spentThisMonthCents: 0,
      billingUrl: "https://openrouter.ai/settings/credits",
      note: null,
      checkedAt: "2026-11-01T12:00:00.000Z",
    });
    await mount();
    expect(host.textContent).toContain("$17.50 left");
    expect(host.textContent).toContain("Add credit");
    expect(host.querySelector("[data-testid=api-key-balance-note]")).toBeNull();
  });
});
