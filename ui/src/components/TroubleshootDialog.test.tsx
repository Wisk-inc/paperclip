// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TroubleshootDialog } from "./TroubleshootDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Resolve = (callId: string, payload: string) => void;
let root: Root;
let container: HTMLDivElement;

/** The Automa app's bridge, answering the troubleshooter with `reply` after `delayMs`. */
function inTheApp(reply: Record<string, unknown>, { canTroubleshoot = true, delayMs = 10 } = {}) {
  const runTroubleshooter = vi.fn((_key: string, callId: string) => {
    setTimeout(() => (window as unknown as { __automaNative: { resolve: Resolve } }).__automaNative.resolve(callId, JSON.stringify(reply)), delayMs);
  });
  Object.assign(window, {
    __automaKey: "page-key",
    AutomaNative: { getInfo: () => "{}", canTroubleshoot: () => canTroubleshoot, runTroubleshooter },
  });
  return runTroubleshooter;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  for (const key of ["AutomaNative", "__automaKey", "__automaNative"]) delete (window as unknown as Record<string, unknown>)[key];
  vi.useRealTimers();
});

const dialog = () => document.querySelector('[data-testid="troubleshoot-dialog"]');
const show = (open: boolean, onOpenChange = vi.fn()) => act(async () => root.render(<TroubleshootDialog open={open} onOpenChange={onOpenChange} />));

describe("TroubleshootDialog", () => {
  it("in the Automa app, runs the troubleshooter once per opening and shows its report", async () => {
    const report = "Automa\n  ✓ Automa is running and ready on http://127.0.0.1:3100\nSummary\n1 problem(s) need you (marked ✗ above).";
    const run = inTheApp({ ok: true, output: report, problems: true });
    await show(true);
    expect(dialog()?.textContent).toContain("Troubleshooting…");
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(run).toHaveBeenCalledTimes(1);
    expect(dialog()?.textContent).toContain("Found problems: what to do is in the report");
    expect(document.querySelector('[data-testid="troubleshoot-report"]')?.textContent).toBe(report);
    await show(true);
    expect(run).toHaveBeenCalledTimes(1);

    await show(false);
    await show(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("says when Termux is still working on it", async () => {
    inTheApp({ ok: true, pending: true });
    await show(true);
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(dialog()?.textContent).toContain("The troubleshooter is taking a while");
    expect(dialog()?.textContent).toContain("open Termux and run: automa troubleshoot");
  });

  it("says why it couldn't run", async () => {
    inTheApp({ ok: false, reason: "old_server", error: "Automa in Termux is older than this app." });
    await show(true);
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(dialog()?.textContent).toContain("Couldn't run the troubleshooter");
    expect(dialog()?.textContent).toContain("Automa in Termux is older than this app.");
  });

  it("drops a report that arrives after the dialog was closed", async () => {
    inTheApp({ ok: true, output: "late report", problems: false }, { delayMs: 1_000 });
    await show(true);
    await show(false);
    await act(async () => vi.advanceTimersByTimeAsync(1_100));
    expect(document.querySelector('[data-testid="troubleshoot-report"]')).toBeNull();
  });

  it("outside the app (or for a server elsewhere) says how to run it in Termux", async () => {
    const run = inTheApp({ ok: true, output: "x" }, { canTroubleshoot: false });
    await show(true);
    expect(dialog()?.textContent).toContain("Troubleshoot Automa");
    expect(dialog()?.textContent).toContain("open Termux and run the command below");
    expect(run).not.toHaveBeenCalled();
  });
});
