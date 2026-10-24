// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "@/lib/router";
import { ApiKeys } from "./ApiKeys";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  studioKeys: vi.fn(),
  deleteStudioKey: vi.fn(),
}));

vi.mock("@/api/ai-connections", () => ({
  aiConnectionsApi: { list: api.list, create: vi.fn(), setDefault: vi.fn(), reveal: vi.fn() },
}));
vi.mock("@/api/studio", () => ({
  studioApi: { aiKeys: api.studioKeys, deleteAiKey: api.deleteStudioKey },
}));
vi.mock("@/api/tools", () => ({ toolsApi: { archiveConnection: vi.fn() } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => undefined }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/components/mascot/Mascot", () => ({ Mascot: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const connection = (overrides: Record<string, unknown>) => ({
  id: "c1", grantId: "g1", companyId: "company-1", provider: "anthropic", method: "api_key",
  name: "Anthropic key ··1234", ownership: "personal", isDefault: false, status: "connected", ...overrides,
});

describe("ApiKeys", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    api.list.mockResolvedValue({
      connections: [
        connection({ id: "mine", grantId: "g-mine" }),
        connection({ id: "team", grantId: "g-team", name: "Team key", ownership: "shared" }),
      ],
    });
    api.studioKeys.mockResolvedValue({
      keys: [
        { provider: "openai", connected: true, last4: "9876", baseUrl: null, updatedAt: null, source: "studio" },
        { provider: "anthropic", connected: true, last4: null, baseUrl: null, updatedAt: null, source: "automa" },
      ],
    });
    api.deleteStudioKey.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(path: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <ApiKeys />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="api-keys-list"]')).not.toBeNull());
  }

  it("opens with the provider an Add key link asked for", async () => {
    await render("/company/settings/api-keys?add=openai");
    expect(container.querySelector('[data-testid="api-key-provider-openai"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("offers Make default only on personal keys", async () => {
    await render("/company/settings/api-keys");
    const rows = [...container.querySelectorAll('[data-testid="api-key-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Make default");
    expect(rows[1]?.textContent).not.toContain("Make default");
  });

  it("lists keys saved in App Studio and removes them", async () => {
    await render("/company/settings/api-keys");
    await vi.waitFor(() => expect(container.querySelector('[data-testid="api-keys-studio"]')).not.toBeNull());
    const studio = container.querySelector('[data-testid="api-keys-studio"]');
    expect(studio?.textContent).toContain("9876");
    expect(studio?.querySelectorAll("li")).toHaveLength(1);
    await act(async () => {
      (container.querySelector('[data-testid="api-key-studio-remove"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(api.deleteStudioKey).toHaveBeenCalledWith("company-1", "openai"));
  });
});
