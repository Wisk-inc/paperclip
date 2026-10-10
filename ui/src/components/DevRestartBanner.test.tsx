// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevRestartBanner } from "./DevRestartBanner";

const mockHealthApi = vi.hoisted(() => ({
  requestDevServerRestart: vi.fn(),
}));

vi.mock("../api/health", () => ({
  healthApi: mockHealthApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

const devServer = {
  enabled: true as const,
  restartRequired: true,
  reason: "backend_changes" as const,
  lastChangedAt: "2026-03-20T12:00:00.000Z",
  changedPathCount: 1,
  changedPathsSample: ["server/src/routes/health.ts"],
  pendingMigrations: [],
  autoRestartEnabled: true,
  activeRunCount: 1,
  waitingForIdle: true,
  lastRestartAt: "2026-03-20T11:30:00.000Z",
};

beforeEach(() => {
  mockHealthApi.requestDevServerRestart.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  mockHealthApi.requestDevServerRestart.mockReset();
});

function render(overrides: Partial<typeof devServer> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<DevRestartBanner devServer={{ ...devServer, ...overrides }} />));
  return container;
}

function card() {
  return document.querySelector<HTMLElement>('[data-testid="dev-restart-card"]');
}

function buttonWithText(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.includes(text));
}

async function click(element: Element | null | undefined) {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("DevRestartBanner", () => {
  it("opens as a centered card over the page", () => {
    render();
    expect(card()).toBeTruthy();
    expect(card()?.className).toContain("top-(--pct-50)");
    expect(card()?.textContent).toContain("Waiting for 1 live run to finish");
    expect(document.querySelector('[data-slot="dialog-overlay"]')?.className).toContain("backdrop-blur-md");
  });

  it("asks for a second tap before interrupting live runs", async () => {
    render();
    await click(buttonWithText("Restart now"));

    expect(mockHealthApi.requestDevServerRestart).not.toHaveBeenCalled();
    expect(card()?.textContent).toContain("Restarting now may interrupt 1 live run. Tap again to restart.");

    await click(buttonWithText("Restart anyway"));

    expect(mockHealthApi.requestDevServerRestart).toHaveBeenCalledTimes(1);
    expect(card()?.textContent).toContain("Restart requested");
  });

  it("restarts with one tap when nothing is running", async () => {
    render({ activeRunCount: 0, waitingForIdle: false });
    await click(buttonWithText("Restart now"));
    expect(mockHealthApi.requestDevServerRestart).toHaveBeenCalledTimes(1);
  });

  it("tucks away with Later and comes back from the edge tab", async () => {
    render();
    await click(buttonWithText("Later"));

    expect(card()).toBeNull();
    const tab = document.querySelector('[data-testid="dev-restart-tab"]');
    expect(tab).toBeTruthy();

    await click(tab);

    expect(card()).toBeTruthy();
    expect(document.querySelector('[data-testid="dev-restart-tab"]')).toBeNull();
  });

  it("shows a failed request in the card", async () => {
    mockHealthApi.requestDevServerRestart.mockRejectedValue(new Error("Restart is not available"));
    render({ activeRunCount: 0, waitingForIdle: false });
    await click(buttonWithText("Restart now"));

    expect(card()?.textContent).toContain("Restart is not available");
    expect(buttonWithText("Restart now")?.disabled).toBe(false);
  });

  it("re-enables the manual restart action when a request does not refresh the page", async () => {
    vi.useFakeTimers();
    render({ activeRunCount: 0, waitingForIdle: false });
    const button = buttonWithText("Restart now");

    await click(button);

    expect(button?.disabled).toBe(true);
    expect(card()?.textContent).toContain("Restart requested");

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(button?.disabled).toBe(false);
    expect(card()?.textContent).toContain("Restart now");
  });
});
