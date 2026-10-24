// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { StudioThinkingControl, effectiveStudioThinking } from "./StudioThinkingControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StudioThinkingControl", () => {
  it("offers the model's levels and reports the one picked", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    try {
      await act(async () => root.render(<StudioThinkingControl provider="anthropic" model="claude-opus-5-5" value={undefined} onChange={onChange} />));
      const levels = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      expect(levels.map((item) => item.textContent)).toEqual(["Auto", "Quick", "Balanced", "Deep", "Deeper", "Max"]);
      expect(levels[0]!.getAttribute("aria-checked")).toBe("true");
      await act(async () => levels[5]!.click());
      expect(onChange).toHaveBeenCalledWith("max");

      // Back to Auto clears the level.
      await act(async () => root.render(<StudioThinkingControl provider="anthropic" model="claude-opus-5-5" value="max" onChange={onChange} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-thinking-level="auto"]')!.click());
      expect(onChange).toHaveBeenLastCalledWith(undefined);

      // A model with no levels says so instead of showing choices that do nothing.
      await act(async () => root.render(<StudioThinkingControl provider="xai" model="grok-4.7" value="high" onChange={onChange} />));
      expect(container.querySelector('[role="radio"]')).toBeNull();
      expect(container.querySelector('[data-testid="studio-thinking-none"]')?.textContent).toContain("no thinking modes");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("drops a level the next model does not take", () => {
    expect(effectiveStudioThinking("anthropic", "claude-opus-5-5", "xhigh")).toBe("xhigh");
    expect(effectiveStudioThinking("anthropic", "claude-opus-4-6", "xhigh")).toBeUndefined();
    expect(effectiveStudioThinking("openrouter", "google/gemini-4-argon", "high")).toBe("high");
    expect(effectiveStudioThinking("deepseek", "deepseek-chat", "high")).toBeUndefined();
  });
});
