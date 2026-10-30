// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioUsageSummary } from "@paperclipai/shared";

const usageMock = vi.hoisted(() => vi.fn<() => Promise<StudioUsageSummary>>());
vi.mock("@/api/studio", () => ({ studioApi: { usage: usageMock } }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { StudioUsageCard } from "./StudioUsageCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StudioUsageCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    usageMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const draw = async (props: Partial<Parameters<typeof StudioUsageCard>[0]> = {}) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <StudioUsageCard companyId="company-1" {...props} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it("shows nothing before App Studio used any model", async () => {
    usageMock.mockResolvedValue({ since: "2026-10-01T00:00:00.000Z", models: [] });
    await draw();
    expect(container.querySelector('[data-testid="studio-usage-card"]')).toBeNull();
  });

  it("lists each model with its logo, tokens and cost, the free ones as Free", async () => {
    usageMock.mockResolvedValue({
      since: "2026-10-01T00:00:00.000Z",
      models: [
        { provider: "free", model: "nvidia/nemotron-3-ultra-550b-a55b:free", calls: 12, inputTokens: 40_000, outputTokens: 4_000, costCents: 0, equivalentCents: 12 },
        { provider: "anthropic", model: "claude-opus-5-5", calls: 2, inputTokens: 5_000, outputTokens: 1_000, costCents: 37, equivalentCents: 37 },
      ],
    });
    await draw({ linkToStudio: true });

    const card = container.querySelector('[data-testid="studio-usage-card"]')!;
    expect(card.textContent).toContain("50k");
    expect(card.textContent).toContain("2 models · 44k on the free models · $0.37 spent · worth $0.49 at paid prices");
    const rows = [...card.querySelectorAll('[data-testid="studio-usage-model"]')];
    expect(rows).toHaveLength(2);
    // The free model costs nothing; this is what the paid version would have charged.
    expect(rows[0]!.textContent).toContain("40k in · 4.0k out · Free · worth $0.12");
    expect(rows[1]!.textContent).toContain("5.0k in · 1.0k out · $0.37");
    expect(rows[1]!.textContent).not.toContain("worth");
    expect(rows[0]!.querySelector('[data-slot="model-logo"]')).not.toBeNull();
    expect(card.querySelector('a[href="/studio"]')).not.toBeNull();
  });
});
