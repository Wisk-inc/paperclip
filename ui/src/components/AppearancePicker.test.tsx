// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { AppearancePicker } from "./AppearancePicker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppearancePicker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.accent;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("starts black and white and remembers a new color", () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <AppearancePicker />
        </ThemeProvider>,
      );
    });
    expect(document.documentElement.dataset.accent).toBeUndefined();
    expect(container.querySelector('[data-testid="accent-classic"]')?.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("automa.accent")).toBeNull();

    act(() => {
      (container.querySelector('[data-testid="accent-indigo"]') as HTMLButtonElement).click();
    });
    expect(document.documentElement.dataset.accent).toBe("indigo");
    expect(localStorage.getItem("automa.accent")).toBe("indigo");

    act(() => {
      (container.querySelector('[data-testid="accent-jamaica"]') as HTMLButtonElement).click();
    });
    expect(document.documentElement.dataset.accent).toBe("jamaica");
    expect(localStorage.getItem("automa.accent")).toBe("jamaica");

    act(() => {
      (container.querySelector('[data-testid="accent-classic"]') as HTMLButtonElement).click();
    });
    expect(document.documentElement.dataset.accent).toBeUndefined();
    expect(localStorage.getItem("automa.accent")).toBe("classic");
  });
});
