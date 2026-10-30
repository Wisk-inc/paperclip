// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownTableScroll } from "./MarkdownBody";

describe("MarkdownTableScroll", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function region() {
    return container.querySelector<HTMLDivElement>('[aria-label="Scrollable table"]')!;
  }

  function layout(element: HTMLElement, { scrollWidth, clientWidth, scrollLeft }: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
    Object.defineProperty(element, "scrollWidth", { value: scrollWidth, configurable: true });
    Object.defineProperty(element, "clientWidth", { value: clientWidth, configurable: true });
    Object.defineProperty(element, "scrollLeft", { value: scrollLeft, configurable: true });
    flushSync(() => element.dispatchEvent(new Event("scroll")));
  }

  it("fades whichever edge of a wide table has more to scroll", () => {
    flushSync(() =>
      root.render(
        <MarkdownTableScroll>
          <table><tbody><tr><td>Tastee</td><td>$320 JMD</td></tr></tbody></table>
        </MarkdownTableScroll>,
      ),
    );
    expect(region().hasAttribute("data-more-left")).toBe(false);
    expect(region().hasAttribute("data-more-right")).toBe(false);

    layout(region(), { scrollWidth: 600, clientWidth: 300, scrollLeft: 0 });
    expect(region().hasAttribute("data-more-left")).toBe(false);
    expect(region().hasAttribute("data-more-right")).toBe(true);

    layout(region(), { scrollWidth: 600, clientWidth: 300, scrollLeft: 150 });
    expect(region().hasAttribute("data-more-left")).toBe(true);
    expect(region().hasAttribute("data-more-right")).toBe(true);

    layout(region(), { scrollWidth: 600, clientWidth: 300, scrollLeft: 300 });
    expect(region().hasAttribute("data-more-left")).toBe(true);
    expect(region().hasAttribute("data-more-right")).toBe(false);
  });

  it("leaves a table that fits alone", () => {
    flushSync(() =>
      root.render(
        <MarkdownTableScroll>
          <table><tbody><tr><td>Fits</td></tr></tbody></table>
        </MarkdownTableScroll>,
      ),
    );
    layout(region(), { scrollWidth: 300, clientWidth: 300, scrollLeft: 0 });
    expect(region().hasAttribute("data-more-left")).toBe(false);
    expect(region().hasAttribute("data-more-right")).toBe(false);
  });
});
