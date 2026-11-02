// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BudgetIncident } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetIncidentCard } from "./BudgetIncidentCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function incident(thresholdType: "soft" | "hard") {
  return {
    id: "i1",
    scopeType: "agent",
    scopeName: "Ada",
    thresholdType,
    amountLimit: 1000,
    amountObserved: thresholdType === "soft" ? 820 : 1010,
    status: "open",
    approvalStatus: null,
  } as unknown as BudgetIncident;
}

let root: Root;
let container: HTMLDivElement;

describe("BudgetIncidentCard", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("tells a soft threshold as a warning: nothing is paused, and it can be dismissed", async () => {
    const onKeepPaused = vi.fn();
    await act(async () => root.render(<BudgetIncidentCard incident={incident("soft")} onRaiseAndResume={vi.fn()} onKeepPaused={onKeepPaused} />));
    expect(container.textContent).toContain("agent budget warning");
    expect(container.textContent).toContain("Nothing is paused yet");
    expect(container.textContent).not.toContain("hard stop");
    expect(container.textContent).not.toContain("Keep paused");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Dismiss warning")!.click());
    expect(onKeepPaused).toHaveBeenCalled();
  });

  it("tells a hard stop as paused until its budget is raised", async () => {
    await act(async () => root.render(<BudgetIncidentCard incident={incident("hard")} onRaiseAndResume={vi.fn()} onKeepPaused={vi.fn()} />));
    expect(container.textContent).toContain("agent hard stop");
    expect(container.textContent).toContain("until its budget is raised");
    expect(container.textContent).toContain("Keep paused");
  });
});
