// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthStatus } from "../api/health";
import { queryKeys } from "../lib/queryKeys";

const mockHealthApi = vi.hoisted(() => ({ restartNormally: vi.fn() }));
vi.mock("../api/health", () => ({ healthApi: mockHealthApi }));
import { SAFE_MODE_RESTART_PATIENCE_MS, SAFE_MODE_RESTART_POLL_MS, SAFE_MODE_SLOW_POLL_MS, SafeModeBanner } from "./SafeModeBanner";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const serverInfo = (processStartedAt: string) => ({
  processStartedAt,
  git: { available: false as const },
}) as unknown as HealthStatus["serverInfo"];

const safeHealth = (extra: Partial<HealthStatus> = {}): HealthStatus => ({
  status: "ok",
  safeMode: true,
  safeModeReason: "crashes",
  safeModeRestartAvailable: true,
  serverInfo: serverInfo("2026-11-17T01:00:00.000Z"),
  ...extra,
});

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  mockHealthApi.restartNormally.mockReset();
  mockHealthApi.restartNormally.mockResolvedValue(undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  client.clear();
  delete (window as { AutomaNative?: unknown }).AutomaNative;
  delete (window as { __automaKey?: unknown }).__automaKey;
  delete (window as { __automaNative?: unknown }).__automaNative;
  vi.useRealTimers();
});

async function show(health: HealthStatus | undefined) {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <SafeModeBanner health={health} />
    </QueryClientProvider>,
  ));
}
const banner = () => container.querySelector('[data-testid="safe-mode-banner"]');
const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

describe("SafeModeBanner", () => {
  it("shows nothing on a normal start", async () => {
    await show({ status: "ok" });
    expect(banner()).toBeNull();
    await show(undefined);
    expect(banner()).toBeNull();
  });

  it("says why Automa is in safe mode", async () => {
    await show(safeHealth());
    expect(banner()?.textContent).toContain("Automa kept stopping while it started, so it started in safe mode.");
    expect(banner()?.textContent).toContain("agents, schedules and plugins wait for a normal start");
    await show(safeHealth({ safeModeReason: "asked" }));
    expect(banner()?.textContent).toContain("Automa started in safe mode, as asked.");
  });

  it("without the automa launcher, says how to start normally instead of offering a button that can't work", async () => {
    await show(safeHealth({ safeModeRestartAvailable: false }));
    expect(container.querySelector('[data-testid="safe-mode-restart"]')).toBeNull();
    expect(banner()?.textContent).toContain("To start it normally, run automa restart in Termux.");
  });

  it("Restart normally asks the server, waits for Automa to come back, and goes away once it is back normally", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await show(safeHealth());
    await act(async () => button("safe-mode-restart").click());
    expect(mockHealthApi.restartNormally).toHaveBeenCalledTimes(1);
    expect(banner()?.textContent).toContain("Restarting Automa normally…");
    expect(button("safe-mode-restart").disabled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(SAFE_MODE_RESTART_POLL_MS * 2));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.health });
    const asks = invalidate.mock.calls.length;
    expect(asks).toBeGreaterThanOrEqual(2);

    // The server is back without safe mode.
    await show({ status: "ok", serverInfo: serverInfo("2026-11-17T01:05:00.000Z") });
    expect(banner()).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(SAFE_MODE_RESTART_POLL_MS * 3));
    expect(invalidate.mock.calls.length).toBe(asks);
  });

  it("says so when Automa came back in safe mode again", async () => {
    await show(safeHealth());
    await act(async () => button("safe-mode-restart").click());
    // The old server still answers for a moment: the same start time.
    await show(safeHealth());
    expect(banner()?.textContent).toContain("Restarting Automa normally…");
    // A new server, in safe mode again: it kept stopping while starting normally.
    await show(safeHealth({ serverInfo: serverInfo("2026-11-17T01:07:00.000Z") }));
    expect(banner()?.textContent).toContain("Automa stopped again while starting normally, so it's back in safe mode.");
    expect(button("safe-mode-restart").disabled).toBe(false);
  });

  it("says so when Automa doesn't come back for a few minutes", async () => {
    await show(safeHealth());
    await act(async () => button("safe-mode-restart").click());
    await act(async () => vi.advanceTimersByTimeAsync(SAFE_MODE_RESTART_PATIENCE_MS));
    expect(banner()?.textContent).toContain("Automa hasn't come back yet.");
  });

  it("keeps asking after that, so an Automa that comes back later is seen (health is not polled otherwise)", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await show(safeHealth());
    await act(async () => button("safe-mode-restart").click());
    await act(async () => vi.advanceTimersByTimeAsync(SAFE_MODE_RESTART_PATIENCE_MS));
    expect(banner()?.textContent).toContain("Automa hasn't come back yet.");
    const asked = invalidate.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(SAFE_MODE_SLOW_POLL_MS * 2));
    expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(asked + 2);
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: queryKeys.health });

    // Back after a long start, in safe mode again: said as such, not "hasn't come back".
    await show(safeHealth({ serverInfo: serverInfo("2026-11-17T01:09:00.000Z") }));
    expect(banner()?.textContent).toContain("Automa stopped again while starting normally, so it's back in safe mode.");
  });

  it("goes away when Automa comes back normally after the long wait", async () => {
    await show(safeHealth());
    await act(async () => button("safe-mode-restart").click());
    await act(async () => vi.advanceTimersByTimeAsync(SAFE_MODE_RESTART_PATIENCE_MS));
    await show({ status: "ok", serverInfo: serverInfo("2026-11-17T01:09:00.000Z") });
    expect(banner()).toBeNull();
  });

  it("shows why the server refused, and stays as it was", async () => {
    mockHealthApi.restartNormally.mockRejectedValue(new Error("Only the owner of this Automa can restart it."));
    await show(safeHealth());
    await act(async () => button("safe-mode-restart").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Only the owner of this Automa can restart it.");
    expect(banner()?.textContent).toContain("Automa kept stopping while it started");
    expect(button("safe-mode-restart").disabled).toBe(false);
  });

  it("Troubleshoot outside the Automa app says how to run it in Termux", async () => {
    await show(safeHealth());
    await act(async () => button("safe-mode-troubleshoot").click());
    const dialog = button("troubleshoot-dialog");
    expect(dialog.textContent).toContain("open Termux and run the command below");
    expect(dialog.textContent).toContain("automa troubleshoot");
  });

  it("Troubleshoot in the Automa app runs the troubleshooter in Termux and shows its report", async () => {
    const report = "Database\n  ✓ Fixed: Cleared PostgreSQL's lock file from before.\nSummary\nNo problems found. Fixed 1 thing(s) along the way.";
    const runTroubleshooter = vi.fn((_key: string, callId: string) => {
      setTimeout(() => (window as unknown as { __automaNative: { resolve: (id: string, payload: string) => void } })
        .__automaNative.resolve(callId, JSON.stringify({ ok: true, output: report, problems: false })), 10);
    });
    Object.assign(window, {
      __automaKey: "page-key",
      AutomaNative: { getInfo: () => "{}", canTroubleshoot: () => true, runTroubleshooter },
    });
    await show(safeHealth());
    await act(async () => button("safe-mode-troubleshoot").click());
    expect(button("troubleshoot-dialog").textContent).toContain("Troubleshooting…");
    expect(runTroubleshooter).toHaveBeenCalledWith("page-key", expect.any(String));
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(button("troubleshoot-dialog").textContent).toContain("No problems found");
    expect(button("troubleshoot-report").textContent).toBe(report);
  });
});
