// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StudioFileNode } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyMock = vi.hoisted(() => vi.fn(async (_text: string) => undefined));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: copyMock }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));
vi.mock("../mascot/Mascot", () => ({ Mascot: () => null }));

import { StudioAssets } from "./StudioAssets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (path: string, size: number): StudioFileNode => ({ name: path.split("/").pop()!, path, type: "file", size }) as StudioFileNode;

const tree: StudioFileNode[] = [
  {
    name: "assets",
    path: "assets",
    type: "folder",
    children: [
      file("assets/click-sound.wav", 1638),
      file("assets/icons/logo.png", 88),
      file("assets/notes.txt", 12),
    ],
  } as StudioFileNode,
  file("public/hero.png", 435),
  file("index.html", 471),
];

describe("StudioAssets", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    copyMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const draw = async () => {
    await act(async () =>
      root.render(<StudioAssets tree={tree} rawUrl={(path) => `/raw/${path}`} downloadUrl={(path) => `/download/${path}`} onUpload={vi.fn()} />),
    );
    return [...container.querySelectorAll<HTMLElement>('[data-testid="studio-asset-name"]')];
  };

  it("labels a card with the file's name, not the assets folder, and keeps the whole path in the title", async () => {
    const names = await draw();
    // Only the leading "assets/" goes: a folder inside it, and files kept elsewhere, still show where they are.
    expect(names.map((name) => name.textContent)).toEqual(["click-sound.wav", "icons/logo.png", "public/hero.png"]);
    expect(names.map((name) => name.title)).toEqual(["assets/click-sound.wav", "assets/icons/logo.png", "public/hero.png"]);
    // The name has a line to itself, so the two buttons do not take its room.
    for (const name of names) {
      expect(name.className.split(/\s+/)).toContain("truncate");
      expect(name.parentElement!.className.split(/\s+/)).toContain("flex-col");
      expect(name.parentElement!.querySelectorAll(":scope > button, :scope > a")).toHaveLength(0);
    }
  });

  it("copies the whole path, and gives Copy and Download thumb-sized targets on touch screens", async () => {
    await draw();
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy the path of click-sound.wav"]')!;
    const download = container.querySelector<HTMLAnchorElement>('a[aria-label="Download click-sound.wav"]')!;
    for (const control of [copy, download]) {
      expect(control.className.split(/\s+/)).toEqual(expect.arrayContaining(["size-6", "pointer-coarse:size-10", "shrink-0"]));
    }
    expect(download.getAttribute("href")).toBe("/download/assets/click-sound.wav");
    expect(download.getAttribute("download")).toBe("click-sound.wav");
    await act(async () => copy.click());
    expect(copyMock).toHaveBeenCalledWith("assets/click-sound.wav");
  });

  it("lays the cards out by the width of its own pane", async () => {
    await draw();
    const pane = container.querySelector('[data-testid="studio-assets"]')!;
    expect(pane.className.split(/\s+/)).toContain("@container");
    const grid = pane.querySelector("ul")!.className.split(/\s+/);
    expect(grid).toEqual(expect.arrayContaining(["grid-cols-2", "@xl:grid-cols-3"]));
    // Not by the screen's: beside the editor the pane is 240 px wide on the widest screen.
    expect(grid.some((name) => /^(sm|md|lg|xl):grid-cols-/.test(name))).toBe(false);
  });
});
