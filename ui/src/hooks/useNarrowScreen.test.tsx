// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NARROW_SCREEN_QUERY, useNarrowScreen } from "./useNarrowScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A screen that answers the hook's one query the way a browser of that size does. */
function installScreen(initial: { width: number; height: number }) {
  let size = initial;
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  const matches = () => size.width <= 1180 || size.height <= 519;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      queries.push(query);
      return {
        media: query,
        get matches() {
          return matches();
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      };
    }),
  );
  return {
    queries,
    listeners,
    resize(next: { width: number; height: number }) {
      const before = matches();
      size = next;
      if (matches() !== before) for (const listener of [...listeners]) listener();
    },
  };
}

describe("useNarrowScreen", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function Probe() {
    return <span>{useNarrowScreen() ? "one pane" : "three columns"}</span>;
  }

  it("asks for screens too narrow or too short for three columns", () => {
    // 240 px of file tree and 384 px of side panel leave the editor 282 px at 1180 wide,
    // and a phone held sideways (915 by 412) is wide but far too short.
    expect(NARROW_SCREEN_QUERY).toBe("(max-width: 1180px), (max-height: 519px)");
  });

  it.each([
    [412, 915, "one pane"],
    [915, 412, "one pane"],
    [800, 1280, "one pane"],
    [1024, 768, "one pane"],
    [1180, 820, "one pane"],
    [1181, 820, "three columns"],
    [1280, 800, "three columns"],
    [1280, 519, "one pane"],
  ])("at %i by %i shows %s", async (width, height, expected) => {
    const screen = installScreen({ width, height });
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe(expected);
    expect(new Set(screen.queries)).toEqual(new Set([NARROW_SCREEN_QUERY]));
  });

  it("follows the screen when the phone is turned, and stops listening when it goes away", async () => {
    const screen = installScreen({ width: 1280, height: 800 });
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe("three columns");

    await act(async () => screen.resize({ width: 915, height: 412 }));
    expect(container.textContent).toBe("one pane");

    await act(async () => screen.resize({ width: 1280, height: 800 }));
    expect(container.textContent).toBe("three columns");

    await act(async () => root.render(null));
    expect(screen.listeners.size).toBe(0);
  });
});
