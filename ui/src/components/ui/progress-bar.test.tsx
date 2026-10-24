// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./progress-bar";
import { latestConsoleLine } from "../studio/console-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProgressBar", () => {
  it("fills to a known amount and sweeps when the amount is unknown", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ProgressBar label="Loading" value={0.426} />));
      const bar = container.querySelector('[role="progressbar"]')!;
      expect(bar.getAttribute("aria-valuenow")).toBe("43");
      expect(bar.hasAttribute("data-indeterminate")).toBe(false);
      expect((container.querySelector('[data-slot="progress-fill"]') as HTMLElement).style.width).toBe("43%");

      await act(async () => root.render(<ProgressBar label="Loading" valueText="Waiting for Termux" />));
      const sweeping = container.querySelector('[role="progressbar"]')!;
      expect(sweeping.hasAttribute("data-indeterminate")).toBe(true);
      expect(sweeping.getAttribute("aria-valuenow")).toBeNull();
      expect(sweeping.getAttribute("aria-valuetext")).toBe("Waiting for Termux");

      await act(async () => root.render(<ProgressBar label="Loading" value={4} />));
      expect(container.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("100");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("latestConsoleLine", () => {
  const line = (seq: number, text: string, at: string) => ({ seq, stream: "stdout" as const, text, at });
  it("returns the newest printed line since the run started, without colour codes", () => {
    const lines = [
      line(1, "old run output", "2026-10-24T10:00:00.000Z"),
      line(2, "\u001b[32madded 120 packages\u001b[0m", "2026-10-24T10:05:01.000Z"),
      line(3, "   ", "2026-10-24T10:05:02.000Z"),
    ];
    expect(latestConsoleLine(lines, "2026-10-24T10:05:00.000Z")).toBe("added 120 packages");
    expect(latestConsoleLine(lines.slice(0, 1), "2026-10-24T10:05:00.000Z")).toBe("");
    expect(latestConsoleLine(lines)).toBe("added 120 packages");
  });
});
