// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLabel, UsageLimitsCard } from "./UsageLimitsCard";

const costs = vi.hoisted(() => ({ quotaWindows: vi.fn() }));
vi.mock("@/api/costs", () => ({ costsApi: costs }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function show(results: ProviderQuotaResult[]) {
  costs.quotaWindows.mockResolvedValue(results);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <UsageLimitsCard companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("UsageLimitsCard", () => {
  it("shows each limit's use with a bar and when it resets, free models first", async () => {
    const inThreeHours = new Date(Date.now() + 3 * 60 * 60_000 + 30_000).toISOString();
    await show([
      {
        provider: "anthropic",
        ok: true,
        windows: [{ label: "Current session", usedPercent: 23, resetsAt: inThreeHours, valueLabel: null }],
      },
      {
        provider: "free_models",
        ok: true,
        windows: [
          { label: "Monthly allowance", usedPercent: 36.6, resetsAt: "2099-11-01T00:00:00.000Z", valueLabel: "634 of 1,000 credits left", detail: "Shared by everyone on Automa's free models." },
          { label: "DeepSeek V4.1 Flash", usedPercent: 100, resetsAt: inThreeHours, valueLabel: "Daily limit reached", detail: "40 requests this month" },
          { label: "Nemotron 3 Ultra 550B", usedPercent: null, resetsAt: null, valueLabel: "Available", detail: "186 requests this month" },
        ],
      },
    ]);

    const card = container.querySelector('[data-testid="usage-limits"]');
    expect(card?.textContent).toContain("Usage limits");
    const sections = [...container.querySelectorAll("section")].map((section) => section.getAttribute("aria-label"));
    expect(sections).toEqual(["Free models", "Anthropic"]);

    const bars = [...container.querySelectorAll('[role="progressbar"]')].map((bar) => bar.getAttribute("aria-label"));
    expect(bars).toEqual([
      "Monthly allowance: 37% used",
      "DeepSeek V4.1 Flash: 100% used",
      "Current session: 23% used",
    ]);
    expect(card?.textContent).toContain("634 of 1,000 credits left · Resets");
    expect(card?.textContent).toContain("Daily limit reached · Resets in 3 h");
    // A model with no known cap shows its state, without a bar.
    expect(card?.textContent).toContain("Available");
    expect(card?.textContent).toContain("186 requests this month");
  });

  it("says when the free models' usage could not be read, and hides when nothing reports a limit", async () => {
    await show([{ provider: "free_models", ok: false, error: "Couldn't read the free models' usage: offline", windows: [] }]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("offline");

    act(() => root.unmount());
    root = createRoot(container);
    await show([{ provider: "anthropic", ok: false, error: "Not signed in", windows: [] }]);
    expect(container.querySelector('[data-testid="usage-limits"]')).toBeNull();
  });
});

describe("resetLabel", () => {
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  it("counts down within a day and names the day after that", () => {
    expect(resetLabel("2026-10-29T12:00:30.000Z", now)).toBe("Resets in under a minute");
    expect(resetLabel("2026-10-29T12:45:00.000Z", now)).toBe("Resets in 45 min");
    expect(resetLabel("2026-10-29T15:00:00.000Z", now)).toBe("Resets in 3 h");
    expect(resetLabel("2026-10-29T15:20:00.000Z", now)).toBe("Resets in 3 h 20 min");
    expect(resetLabel("2026-10-31T12:00:00.000Z", now)).toMatch(/^Resets \w+/);
    expect(resetLabel("2026-11-20T00:00:00.000Z", now)).toMatch(/^Resets (Nov 20|20 Nov)$/);
    expect(resetLabel("soon", now)).toBeNull();
  });
});
