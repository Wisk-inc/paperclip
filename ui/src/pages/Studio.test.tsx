// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNDO_WINDOW_MS } from "../hooks/useUndoableAction";
import { Studio } from "./Studio";

const mockStudioApi = vi.hoisted(() => ({
  catalog: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
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
/** What the page last handed the New app sheet. */
const newAppSheet = vi.hoisted(() => ({ props: null as null | { open: boolean; startWith?: string | null; returnFocusRef?: { current: HTMLElement | null } } }));
vi.mock("../components/studio/NewStudioAppSheet", () => ({
  NewStudioAppSheet: (props: NonNullable<typeof newAppSheet.props>) => {
    newAppSheet.props = props;
    return null;
  },
}));

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

describe("Studio: where focus goes when a dialog closes", () => {
  const WORKSPACE = { id: "ws-1", companyId: "company-1", name: "Recipe box", language: "html", description: null, sourceUrl: null, runCommand: null, createdByUserId: null, shareCode: null, shareEnabled: false, shareExpiresAt: null, lastRunAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", run: null };

  async function mountStudio() {
    (globalThis as { PointerEvent?: unknown }).PointerEvent ??= MouseEvent;
    mockStudioApi.catalog.mockResolvedValue({ languages: [], cloudflared: false });
    mockStudioApi.list.mockResolvedValue({ workspaces: [WORKSPACE] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Studio />
        </QueryClientProvider>,
      ),
    );
    await settle();
    const unmount = async () => {
      await act(async () => root.unmount());
      container.remove();
    };
    return { container, unmount };
  }

  it("returns to the app's menu button after the Rename dialog closes", async () => {
    const view = await mountStudio();
    try {
      const menuButton = view.container.querySelector<HTMLButtonElement>('[data-testid="studio-app-menu"]')!;
      await act(async () => {
        menuButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        menuButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle();
      await act(async () => document.body.querySelector<HTMLElement>('[data-testid="studio-app-rename"]')!.click());
      await settle();
      expect(document.body.querySelector('[data-testid="studio-rename-input"]')).not.toBeNull();

      const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "Cancel")!;
      await act(async () => cancel.click());
      await settle();
      expect(document.body.querySelector('[data-testid="studio-rename-input"]')).toBeNull();
      // Not the page body: the next Tab continues from the card.
      expect(document.activeElement).toBe(menuButton);
    } finally {
      await view.unmount();
    }
  });

  it("tells the New app sheet which control opened it", async () => {
    const view = await mountStudio();
    try {
      const buttons = [...view.container.querySelectorAll<HTMLButtonElement>("button")];
      const newApp = buttons.find((button) => button.textContent?.trim() === "New app")!;
      const clone = buttons.find((button) => button.textContent?.trim() === "Clone from GitHub")!;

      await act(async () => newApp.click());
      expect(newAppSheet.props?.open).toBe(true);
      expect(newAppSheet.props?.returnFocusRef?.current).toBe(newApp);

      await act(async () => clone.click());
      expect(newAppSheet.props?.startWith).toBe("github");
      expect(newAppSheet.props?.returnFocusRef?.current).toBe(clone);
    } finally {
      await view.unmount();
    }
  });
});

describe("Studio: deleting an app", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says why the delete failed when the app comes back to the list", async () => {
    (globalThis as { PointerEvent?: unknown }).PointerEvent ??= MouseEvent;
    vi.useFakeTimers();
    mockPushToast.mockClear();
    mockStudioApi.catalog.mockResolvedValue({ languages: [], cloudflared: false });
    mockStudioApi.list.mockResolvedValue({
      workspaces: [{ id: "ws-1", companyId: "company-1", name: "Island Weather", language: "html", description: null, sourceUrl: null, runCommand: null, createdByUserId: null, shareCode: null, shareEnabled: false, shareExpiresAt: null, lastRunAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", run: null }],
    });
    mockStudioApi.remove.mockRejectedValue(new Error("You are offline"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wait = async (ms = 50) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    // One menu button per app in the list (the test's Link stand-in drops the card's own test id).
    const cards = () => container.querySelectorAll('[data-testid="studio-app-menu"]').length;
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Studio />
          </QueryClientProvider>,
        ),
      );
      await wait();
      expect(cards()).toBe(1);
      const trigger = container.querySelector<HTMLButtonElement>('[data-testid="studio-app-menu"]')!;
      await act(async () => {
        trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await wait();
      await act(async () => document.body.querySelector<HTMLElement>('[data-testid="studio-app-delete"]')!.click());
      await wait();
      expect(cards()).toBe(0);
      expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Deleted Island Weather" }));
      expect(mockStudioApi.remove).not.toHaveBeenCalled();

      await wait(UNDO_WINDOW_MS);
      expect(mockStudioApi.remove).toHaveBeenCalledWith("ws-1");
      // The card is back, and the person is told why.
      expect(cards()).toBe(1);
      expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't delete Island Weather", body: "You are offline", tone: "error" }));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("studioJoinTarget", () => {
  it("opens an invite link as it is", async () => {
    const { studioJoinTarget } = await import("./Studio");
    expect(studioJoinTarget(" https://friend.trycloudflare.com/studio-guest/?code=ABCD2345 ")).toBe("https://friend.trycloudflare.com/studio-guest/?code=ABCD2345");
  });

  it("looks a code up on this Automa, only when it is as long as the server's codes can be", async () => {
    const { studioJoinTarget } = await import("./Studio");
    expect(studioJoinTarget("abcd-2345")).toBe("/studio-guest/?code=ABCD2345");
    // The server refuses codes under six characters: not sent there to fail.
    expect(studioJoinTarget("ABCD")).toBeNull();
    expect(studioJoinTarget("")).toBeNull();
  });
});
