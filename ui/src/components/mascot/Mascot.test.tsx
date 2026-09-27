// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mascot } from "./Mascot";
import { MASCOT_POSES } from "./mascot-art";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Mascot", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps every pose mounted and only switches which one is active", () => {
    const root = createRoot(container);
    act(() => root.render(<Mascot pose="idle" size="lg" />));

    const layers = () => Array.from(container.querySelectorAll<HTMLElement>(".mascot-stills .mascot-layer"));
    expect(layers().map((layer) => layer.dataset.pose)).toEqual([...MASCOT_POSES]);
    expect(layers().filter((layer) => layer.dataset.active === "true").map((layer) => layer.dataset.pose)).toEqual(["idle"]);
    const imagesBefore = Array.from(container.querySelectorAll("img"));

    act(() => root.render(<Mascot pose="confused" size="lg" />));

    expect(layers().filter((layer) => layer.dataset.active === "true").map((layer) => layer.dataset.pose)).toEqual(["confused"]);
    // Same image elements: a pose change is a crossfade, never a remount or reload.
    expect(Array.from(container.querySelectorAll("img"))).toEqual(imagesBefore);
    act(() => root.unmount());
  });

  it("uses an explicit bounding box and colorful character art at that size", () => {
    const root = createRoot(container);
    act(() => root.render(<Mascot pose="excited" size="md" />));

    const box = container.querySelector<HTMLElement>('[data-slot="mascot"]')!;
    expect(box.className).toContain("size-24");
    expect(box.getAttribute("aria-hidden")).toBe("true");
    const image = container.querySelector<HTMLImageElement>('.mascot-stills [data-pose="excited"] img')!;
    expect(image.getAttribute("src")).toBe("/api/agent-avatars/cap-v1/turquoise-cherry/success.png?size=96&scale=1");
    act(() => root.unmount());
  });
});
