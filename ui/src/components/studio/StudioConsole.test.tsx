// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioConsoleLine } from "@paperclipai/shared";
import { StudioConsole } from "./StudioConsole";
import { createStudioConsoleStore } from "./console-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ResizeCallback = (entries: Array<{ contentRect: { height: number; width: number } }>) => void;

/** jsdom has no layout, so the test plays the browser: it reports the box's height itself. */
function stubResizeObserver() {
  const observers: Array<{ callback: ResizeCallback; nodes: Element[]; disconnected: boolean }> = [];
  class FakeResizeObserver {
    private readonly record: (typeof observers)[number];
    constructor(callback: ResizeCallback) {
      this.record = { callback, nodes: [], disconnected: false };
      observers.push(this.record);
    }
    observe(node: Element) {
      this.record.nodes.push(node);
    }
    unobserve() {}
    disconnect() {
      this.record.disconnected = true;
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return observers;
}

function lines(from: number, count: number): StudioConsoleLine[] {
  return Array.from({ length: count }, (_, index) => ({ seq: from + index, stream: "stdout", text: `line ${from + index}`, at: "2026-10-01T00:00:00.000Z" }) as StudioConsoleLine);
}

/** Gives the scroll box the measurements a browser would, and records every scroll the component asks for. */
function instrument(node: HTMLElement, box: { scrollHeight: number; clientHeight: number }) {
  const scrolls: number[] = [];
  let top = 0;
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(node, "clientHeight", { configurable: true, get: () => box.clientHeight });
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
      scrolls.push(value);
    },
  });
  return scrolls;
}

type Observers = ReturnType<typeof stubResizeObserver>;

/** The browser telling whoever watches the box what height it now has (0 while its pane is hidden). */
function reporter(observers: Observers) {
  return (height: number) =>
    act(async () => {
      for (const observer of observers) observer.callback([{ contentRect: { height, width: height ? 380 : 0 } }]);
    });
}

async function mountConsole() {
  const store = createStudioConsoleStore();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<StudioConsole store={store} run={null} />));
  const node = container.querySelector<HTMLElement>('[data-testid="studio-console"]')!;
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { store, node, unmount };
}

describe("StudioConsole", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes to the newest line when its tab is shown again after output printed out of sight", async () => {
    const observers = stubResizeObserver();
    const view = await mountConsole();
    try {
      const report = reporter(observers);

      // On screen, following the output.
      const box = { scrollHeight: 2400, clientHeight: 600 };
      const scrolls = instrument(view.node, box);
      await report(600);
      await act(async () => view.store.merge(lines(1, 120)));
      expect(scrolls.at(-1)).toBe(2400);

      // The person moves to another tab: the pane is hidden (display: none), so it has no size
      // and a scroll set on it does nothing.
      box.scrollHeight = 0;
      box.clientHeight = 0;
      await report(0);
      await act(async () => view.store.merge(lines(1000, 200)));
      scrolls.length = 0;

      // Back on the Console tab: the box has a height again and 200 more lines below.
      box.scrollHeight = 6400;
      box.clientHeight = 600;
      await report(600);
      expect(scrolls).toEqual([6400]);
      expect(observers.map((observer) => observer.nodes)).toEqual([[view.node]]);
    } finally {
      await view.unmount();
    }
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
  });

  it("stays where the person scrolled to when the tab is shown again", async () => {
    const observers = stubResizeObserver();
    const view = await mountConsole();
    try {
      const report = reporter(observers);
      const box = { scrollHeight: 2400, clientHeight: 600 };
      const scrolls = instrument(view.node, box);
      await report(600);
      await act(async () => view.store.merge(lines(1, 120)));

      // Scrolled up to read something earlier: no longer following.
      view.node.scrollTop = 300;
      await act(async () => view.node.dispatchEvent(new Event("scroll")));
      box.scrollHeight = 0;
      box.clientHeight = 0;
      view.node.scrollTop = 0;
      await report(0);
      // A hidden box reports zeros; a scroll event then must not turn following back on.
      await act(async () => view.node.dispatchEvent(new Event("scroll")));
      scrolls.length = 0;

      box.scrollHeight = 6400;
      box.clientHeight = 600;
      await report(600);
      expect(scrolls).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it("only acts when the box comes back from having no height, not on every resize", async () => {
    const observers = stubResizeObserver();
    const view = await mountConsole();
    try {
      const report = reporter(observers);
      const box = { scrollHeight: 2400, clientHeight: 600 };
      const scrolls = instrument(view.node, box);
      await report(600);
      scrolls.length = 0;
      // The keyboard opens and closes: the box changes height but was never hidden.
      await report(320);
      await report(600);
      expect(scrolls).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it("works where the browser has no ResizeObserver", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const view = await mountConsole();
    try {
      await act(async () => view.store.merge(lines(1, 3)));
      expect(view.node.textContent).toContain("line 3");
    } finally {
      await view.unmount();
    }
  });

  it("names an example command short enough to fit a phone, and ends in an ellipsis where it still does not", async () => {
    const store = createStudioConsoleStore();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<StudioConsole store={store} run={null} onExec={vi.fn()} />));
      const box = container.querySelector<HTMLInputElement>('[aria-label="Shell command"]')!;
      // At 412 px the box holds about 37 characters of this font; the old text had 38 and lost its last letters.
      expect(box.placeholder.length).toBeLessThanOrEqual(32);
      expect(box.placeholder).toMatch(/^Run a command/);
      expect(box.className).toMatch(/\btext-ellipsis\b/);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
