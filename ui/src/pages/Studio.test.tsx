// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { Studio } from "./Studio";

const mockStudioApi = vi.hoisted(() => ({
  catalog: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  archiveUrl: vi.fn(() => "/archive.zip"),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/studio", () => ({ studioApi: mockStudioApi }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => undefined }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast, dismissToast: () => undefined, clearToasts: () => undefined }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => () => undefined,
}));
vi.mock("../components/studio/NewStudioAppSheet", () => ({ NewStudioAppSheet: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  for (let index = 0; index < 5; index += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("Studio", () => {
  it("says when a rename fails instead of leaving the dialog doing nothing", async () => {
    (globalThis as { PointerEvent?: unknown }).PointerEvent ??= MouseEvent;
    mockStudioApi.catalog.mockResolvedValue({ languages: [], cloudflared: false });
    mockStudioApi.list.mockResolvedValue({
      workspaces: [{ id: "ws-1", companyId: "company-1", name: "Recipe box", language: "html", description: null, sourceUrl: null, runCommand: null, createdByUserId: null, shareCode: null, shareEnabled: false, shareExpiresAt: null, lastRunAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", run: null }],
    });
    mockStudioApi.update.mockRejectedValue(new Error("That name is taken"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Studio />
          </QueryClientProvider>,
        ),
      );
      await settle();
      const trigger = container.querySelector<HTMLButtonElement>('[data-testid="studio-app-menu"]')!;
      await act(async () => {
        trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle();
      await act(async () => document.body.querySelector<HTMLElement>('[data-testid="studio-app-rename"]')!.click());
      await settle();
      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="studio-rename-save"]')!.click());
      await settle();
      expect(mockStudioApi.update).toHaveBeenCalledWith("ws-1", { name: "Recipe box" });
      expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't rename the app", body: "That name is taken", tone: "error" }));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
