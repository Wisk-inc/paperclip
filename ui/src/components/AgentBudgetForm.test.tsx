// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBudgetForm, parseBudgetDollars } from "./AgentBudgetForm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agents = [
  { id: "a-ada", name: "Ada", status: "idle" },
  { id: "a-bo", name: "Bo", status: "idle" },
  { id: "a-old", name: "Old", status: "terminated" },
] as unknown as Agent[];

let root: Root;
let container: HTMLDivElement;

async function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

describe("AgentBudgetForm", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers the agents without a budget, and saves the amount in cents", async () => {
    const onSave = vi.fn();
    await act(async () =>
      root.render(<AgentBudgetForm agents={agents} budgetedAgentIds={new Set(["a-bo"])} isSaving={false} onSave={onSave} />),
    );
    const select = container.querySelector("select")!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Choose an agent…", "Ada"]);
    const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "Set budget")!;
    expect(button.disabled).toBe(true);

    await type(select, "a-ada");
    await type(container.querySelector("input")!, "$25.50");
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(onSave).toHaveBeenCalledWith("a-ada", 2550);
  });

  it("starts on the agent the page was opened for", async () => {
    await act(async () =>
      root.render(<AgentBudgetForm agents={agents} budgetedAgentIds={new Set()} isSaving={false} onSave={vi.fn()} initialAgentId="a-bo" />),
    );
    expect(container.querySelector("select")!.value).toBe("a-bo");
  });

  it("shows nothing when every agent already has a budget", async () => {
    await act(async () =>
      root.render(<AgentBudgetForm agents={agents} budgetedAgentIds={new Set(["a-ada", "a-bo"])} isSaving={false} onSave={vi.fn()} />),
    );
    expect(container.querySelector("[data-testid=agent-budget-form]")).toBeNull();
  });
});

describe("parseBudgetDollars", () => {
  it("reads dollars as cents and refuses what isn't a positive amount", () => {
    expect(parseBudgetDollars("10")).toBe(1000);
    expect(parseBudgetDollars(" $0.99 ")).toBe(99);
    expect(parseBudgetDollars("0")).toBeNull();
    expect(parseBudgetDollars("-5")).toBeNull();
    expect(parseBudgetDollars("ten")).toBeNull();
    expect(parseBudgetDollars("")).toBeNull();
  });
});
