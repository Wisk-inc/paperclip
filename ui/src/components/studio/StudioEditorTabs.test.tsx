// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioFileNode } from "@paperclipai/shared";
import {
  MAX_EDITOR_TABS,
  StudioEditorTabs,
  editorTabsStorageKey,
  existingTabs,
  movedPath,
  neighbourTab,
  readRememberedTabs,
  rememberTabs,
  renameTabs,
  withTab,
  withoutTabs,
} from "./StudioEditorTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StudioEditorTabs", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelect = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const draw = (props: Partial<Parameters<typeof StudioEditorTabs>[0]> = {}) =>
    act(async () =>
      root.render(<StudioEditorTabs tabs={["index.html", "src/app.js", "style.css"]} activePath="src/app.js" onSelect={onSelect} onClose={onClose} {...props} />),
    );
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const tab = (path: string) => tabs().find((item) => item.dataset.path === path)!;
  const openFile = () => container.querySelector('[data-testid="studio-open-file"]')!.textContent;

  it("shows one tab per open file, by name, and marks the open one", async () => {
    await draw();
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs().map((item) => item.textContent)).toEqual(["index.html", "app.js", "style.css"]);
    expect(tabs().map((item) => item.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tab("src/app.js").title).toBe("src/app.js");
    // The open file's full path stays readable under its old test id.
    expect(openFile()).toBe("src/app.js");
    // Every tab has a picture for its kind of file.
    for (const item of tabs()) expect(item.querySelector("img, svg")).not.toBeNull();
  });

  it("says when no file is open, or one is being read", async () => {
    await draw({ tabs: [], activePath: null });
    expect(openFile()).toBe("No file open");
    expect(tabs()).toEqual([]);
    await draw({ tabs: [], activePath: null, loading: true });
    expect(openFile()).toBe("Opening…");
  });

  it("adds the folder to tabs that share a name", async () => {
    await draw({ tabs: ["index.html", "docs/guide/index.html", "docs/notes.md"], activePath: "index.html" });
    expect(tabs().map((item) => item.textContent)).toEqual(["index.html", "index.htmldocs/guide", "notes.md"]);
  });

  it("dots the open file's tab while it has unsaved edits", async () => {
    await draw({ dirty: true });
    expect(tab("src/app.js").querySelector('[data-testid="studio-file-tab-edited"]')).not.toBeNull();
    expect(tab("index.html").querySelector('[data-testid="studio-file-tab-edited"]')).toBeNull();
    await draw({ dirty: false });
    expect(container.querySelector('[data-testid="studio-file-tab-edited"]')).toBeNull();
  });

  it("opens the tab that is tapped and closes the one whose close button is tapped", async () => {
    await draw();
    await act(async () => tab("style.css").click());
    expect(onSelect).toHaveBeenCalledWith("style.css");
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close app.js"]')!.click());
    expect(onClose).toHaveBeenCalledWith("src/app.js");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll('[data-testid="studio-file-tab-close"]')].map((item) => item.getAttribute("aria-label"))).toEqual([
      "Close index.html",
      "Close app.js",
      "Close style.css",
    ]);
  });

  it("closes a tab on a middle click or the Delete key, and moves between tabs with the arrow keys", async () => {
    await draw();
    await act(async () => tab("index.html").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })));
    expect(onClose).toHaveBeenLastCalledWith("index.html");

    tab("src/app.js").focus();
    const press = (key: string) => act(async () => (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    await press("ArrowRight");
    expect(document.activeElement).toBe(tab("style.css"));
    await press("ArrowRight");
    expect(document.activeElement).toBe(tab("index.html"));
    await press("End");
    expect(document.activeElement).toBe(tab("style.css"));
    await press("Delete");
    expect(onClose).toHaveBeenLastCalledWith("style.css");
    // Moving the focus opens nothing by itself.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("has a + that shows the files only where the file list is on another screen", async () => {
    await draw();
    expect(container.querySelector('[data-testid="studio-file-tab-add"]')).toBeNull();
    const onShowFiles = vi.fn();
    await draw({ onShowFiles });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="studio-file-tab-add"]')!.click());
    expect(onShowFiles).toHaveBeenCalledTimes(1);
  });

  it("brings the open file's tab into view", async () => {
    await draw({ activePath: "index.html" });
    const strip = container.querySelector<HTMLElement>('[role="tablist"]')!;
    // jsdom lays nothing out: give the strip room for one tab, and each tab a place.
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 100 });
    for (const [index, item] of [...strip.children].entries()) {
      Object.defineProperty(item, "offsetLeft", { configurable: true, value: index * 100 });
      Object.defineProperty(item, "offsetWidth", { configurable: true, value: 100 });
    }
    await draw({ activePath: "style.css" });
    expect(strip.scrollLeft).toBe(200);
    await draw({ activePath: "src/app.js" });
    expect(strip.scrollLeft).toBe(100);
  });
});

describe("the open-file tab list", () => {
  it("adds a new file at the end and leaves an open one where it is", () => {
    expect(withTab(["a.js", "b.js"], "c.js")).toEqual(["a.js", "b.js", "c.js"]);
    const tabs = ["a.js", "b.js"];
    expect(withTab(tabs, "a.js")).toBe(tabs);
  });

  it("keeps at most twelve tabs, closing the oldest one that is not the file being opened", () => {
    const twelve = Array.from({ length: MAX_EDITOR_TABS }, (_, index) => `file-${index}.js`);
    const next = withTab(twelve, "new.js");
    expect(next).toHaveLength(12);
    expect(next[0]).toBe("file-1.js");
    expect(next.at(-1)).toBe("new.js");
    // With room for one tab only, the file being opened is the one that stays.
    expect(withTab(["old.js"], "new.js", 1)).toEqual(["new.js"]);
  });

  it("renames a file's tab, and the tabs of files in a renamed or moved folder", () => {
    const tabs = ["index.html", "src/app.js", "src/lib/util.js", "srcs/other.js"];
    expect(renameTabs(tabs, "index.html", "home.html")).toEqual(["home.html", "src/app.js", "src/lib/util.js", "srcs/other.js"]);
    expect(renameTabs(tabs, "src", "code")).toEqual(["index.html", "code/app.js", "code/lib/util.js", "srcs/other.js"]);
    expect(renameTabs(tabs, "src/lib", "lib")).toEqual(["index.html", "src/app.js", "lib/util.js", "srcs/other.js"]);
    // Nothing open was part of the move.
    expect(renameTabs(tabs, "docs", "manual")).toBe(tabs);
    // Moved onto a file that had its own tab: one tab, not two.
    expect(renameTabs(["a.js", "b.js"], "a.js", "b.js")).toEqual(["b.js"]);
    expect(movedPath("src/app.js", "src", "code")).toBe("code/app.js");
    expect(movedPath("srcs/other.js", "src", "code")).toBe("srcs/other.js");
  });

  it("closes the tab of a deleted file, and every tab in a deleted folder", () => {
    const tabs = ["index.html", "src/app.js", "src/lib/util.js", "srcs/other.js"];
    expect(withoutTabs(tabs, "index.html")).toEqual(["src/app.js", "src/lib/util.js", "srcs/other.js"]);
    expect(withoutTabs(tabs, "src")).toEqual(["index.html", "srcs/other.js"]);
    expect(withoutTabs(tabs, "missing.js")).toBe(tabs);
  });

  it("picks the tab to the right of a closed one, then the one to its left", () => {
    const tabs = ["a.js", "b.js", "c.js"];
    expect(neighbourTab(tabs, "b.js")).toBe("c.js");
    expect(neighbourTab(tabs, "c.js")).toBe("b.js");
    expect(neighbourTab(tabs, "a.js")).toBe("b.js");
    expect(neighbourTab(["a.js"], "a.js")).toBeNull();
    // A deleted folder closes several at once: the nearest tab that stays.
    const closing = (tab: string) => tab.startsWith("src/");
    expect(neighbourTab(["a.js", "src/b.js", "src/c.js", "d.js"], "src/b.js", closing)).toBe("d.js");
    expect(neighbourTab(["a.js", "src/b.js", "src/c.js"], "src/b.js", closing)).toBe("a.js");
  });

  it("drops tabs of files the tree no longer has", () => {
    const tree: StudioFileNode[] = [
      { name: "index.html", path: "index.html", type: "file" },
      { name: "src", path: "src", type: "folder", children: [{ name: "app.js", path: "src/app.js", type: "file" }] },
      { name: "node_modules", path: "node_modules", type: "folder", unlisted: true, unlistedReason: "dependencies" },
    ];
    expect(existingTabs(["index.html", "gone.js", "src/app.js", "src/gone.js", "src"], tree)).toEqual(["index.html", "src/app.js"]);
    // Files in a folder the tree does not list can't be checked, so they stay.
    expect(existingTabs(["node_modules/lib/index.js"], tree)).toEqual(["node_modules/lib/index.js"]);
    // The open file stays even when the tree has not listed it yet.
    expect(existingTabs(["index.html", "new.js"], tree, (tab) => tab === "new.js")).toEqual(["index.html", "new.js"]);
    const all = ["index.html", "src/app.js"];
    expect(existingTabs(all, tree)).toBe(all);
  });
});

describe("remembered tabs", () => {
  beforeEach(() => window.localStorage.clear());

  it("remembers the tabs and the open file per workspace", () => {
    expect(editorTabsStorageKey("ws-1")).toBe("automa.studio.tabs.ws-1");
    rememberTabs("ws-1", ["index.html", "src/app.js"], "src/app.js");
    rememberTabs("ws-2", ["main.py"], null);
    expect(readRememberedTabs("ws-1")).toEqual({ tabs: ["index.html", "src/app.js"], active: "src/app.js" });
    expect(readRememberedTabs("ws-2")).toEqual({ tabs: ["main.py"], active: null });
    expect(readRememberedTabs("ws-3")).toEqual({ tabs: [], active: null });
  });

  it("reads a plain list of paths, and ignores anything else", () => {
    window.localStorage.setItem("automa.studio.tabs.ws-1", JSON.stringify(["a.js", "b.js", "a.js", 7, ""]));
    expect(readRememberedTabs("ws-1")).toEqual({ tabs: ["a.js", "b.js"], active: null });
    window.localStorage.setItem("automa.studio.tabs.ws-1", JSON.stringify({ tabs: ["a.js"], active: "closed.js" }));
    expect(readRememberedTabs("ws-1")).toEqual({ tabs: ["a.js"], active: null });
    for (const stored of ["not json", JSON.stringify("a.js"), JSON.stringify({ tabs: "a.js" }), JSON.stringify(null)]) {
      window.localStorage.setItem("automa.studio.tabs.ws-1", stored);
      expect(readRememberedTabs("ws-1")).toEqual({ tabs: [], active: null });
    }
  });

  it("works without storage", () => {
    const getItem = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage is off");
    });
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage is off");
    });
    try {
      expect(readRememberedTabs("ws-1")).toEqual({ tabs: [], active: null });
      expect(() => rememberTabs("ws-1", ["a.js"], "a.js")).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
