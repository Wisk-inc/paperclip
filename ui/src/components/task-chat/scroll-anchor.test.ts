// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readThreadScrollAnchor, threadScrollAnchorDelta } from "./scroll-anchor";

function thread(heights: number[], scrollTop: number) {
  const root = document.createElement("div");
  let top = -scrollTop;
  heights.forEach((height, index) => {
    const row = document.createElement("div");
    row.dataset.threadAnchor = `row-${index}`;
    const rowTop = top;
    row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + height, height } as DOMRect);
    root.appendChild(row);
    top += height;
  });
  return root;
}

describe("readThreadScrollAnchor", () => {
  it("finds the first row in view of a long thread", () => {
    const root = thread(Array.from({ length: 500 }, () => 100), 25_050);
    expect(readThreadScrollAnchor(root, 0, 800)).toEqual({ id: "row-250", top: -50 });
  });

  it("skips hidden rows and returns null past the end", () => {
    const root = thread([100, 0, 0, 100], 100);
    expect(readThreadScrollAnchor(root, 0, 800)?.id).toBe("row-3");
    expect(readThreadScrollAnchor(thread([100, 100], 500), 0, 800)).toBeNull();
  });

  it("measures how far the anchor moved", () => {
    const root = thread([100, 100, 100], 150);
    const anchor = readThreadScrollAnchor(root, 0, 800);
    expect(anchor?.id).toBe("row-1");
    expect(threadScrollAnchorDelta(thread([140, 100, 100], 150), anchor, 0)).toBe(40);
  });
});
