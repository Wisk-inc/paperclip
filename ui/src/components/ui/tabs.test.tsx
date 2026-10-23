// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Tabs", () => {
  it("reports one change for one tap on a tab held in the URL", async () => {
    const onValueChange = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <Tabs value="mine" onValueChange={onValueChange}>
            <TabsList>
              <TabsTrigger value="mine">Mine</TabsTrigger>
              <TabsTrigger value="recent">Recent</TabsTrigger>
            </TabsList>
          </Tabs>,
        ),
      );
      const recent = [...container.querySelectorAll("button")].find((button) => button.textContent === "Recent")!;
      // A tap: press, then focus, before the URL (and so the value) has changed.
      await act(async () => {
        recent.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        recent.focus();
      });
      expect(onValueChange).toHaveBeenCalledTimes(1);
      expect(onValueChange).toHaveBeenCalledWith("recent");

      // A later tap on the same tab, after the parent ignored the first one, still counts.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        recent.blur();
        recent.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      });
      expect(onValueChange).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
