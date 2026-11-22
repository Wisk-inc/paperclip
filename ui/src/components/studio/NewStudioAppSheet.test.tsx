// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { NewStudioAppSheet, type NewStudioAppInput } from "./NewStudioAppSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLONE_REFUSED = "Couldn't clone that repository: it is private or does not exist. Check the link and try again.";

/** Types into a controlled input the way a person does. */
async function type(label: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mountSheet(onCreate: (input: NewStudioAppInput) => Promise<void>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<NewStudioAppSheet open onOpenChange={vi.fn()} catalog={undefined} startWith="github" onCreate={onCreate} />));
  const sheet = () => document.body.querySelector<HTMLElement>('[data-testid="new-studio-app"]')!;
  const create = () => sheet().querySelector<HTMLButtonElement>('[data-testid="studio-create-app"]')!;
  const submit = async () => {
    await act(async () => create().click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { sheet, create, submit, unmount };
}

/** The reason is readable in full: a paragraph of its own, above the row of buttons, never cut short. */
function expectReadableError(sheet: HTMLElement, create: HTMLButtonElement, text: string) {
  const alerts = sheet.querySelectorAll<HTMLElement>('[role="alert"]');
  expect(alerts).toHaveLength(1);
  const alert = alerts[0]!;
  expect(alert.textContent).toBe(text);
  expect(alert.className).not.toMatch(/truncate|line-clamp|text-ellipsis|whitespace-nowrap/);

  const footerRow = create.parentElement!;
  expect(footerRow.contains(alert)).toBe(false);
  expect(alert.compareDocumentPosition(footerRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The footer stays one row: Cancel on the left, the primary action on the right.
  const buttons = [...footerRow.children];
  expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Cancel", "Clone app"]);
  expect(footerRow.className).toMatch(/\bflex\b/);
  expect(footerRow.className).toMatch(/\bjustify-between\b/);
  expect(footerRow.className).not.toMatch(/\bflex-col\b/);
}

describe("NewStudioAppSheet", () => {
  it("shows the whole reason a clone failed, above the buttons", async () => {
    const onCreate = vi.fn(() => Promise.reject(new Error(CLONE_REFUSED)));
    const view = await mountSheet(onCreate);
    try {
      await type("Repository link", "https://github.com/owner/repo");
      await type("App name", "My copy");
      await view.submit();
      expect(onCreate).toHaveBeenCalledWith({ name: "My copy", language: "auto", description: null, gitUrl: "https://github.com/owner/repo" });
      expectReadableError(view.sheet(), view.create(), CLONE_REFUSED);
    } finally {
      await view.unmount();
    }
  });

  it("shows a form mistake the same way, and takes no room when there is none", async () => {
    const onCreate = vi.fn(() => Promise.resolve());
    const view = await mountSheet(onCreate);
    try {
      expect(view.sheet().querySelector('[role="alert"]')).toBeNull();
      await type("Repository link", "github.com/owner/repo");
      await type("App name", "My copy");
      await view.submit();
      expect(onCreate).not.toHaveBeenCalled();
      expectReadableError(view.sheet(), view.create(), "Paste an https:// link to a Git repository.");
    } finally {
      await view.unmount();
    }
  });

  it("sends focus back to the control that opened it when it closes", async () => {
    const opener = document.createElement("button");
    opener.textContent = "New app";
    document.body.appendChild(opener);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const sheet = (open: boolean) => <NewStudioAppSheet open={open} onOpenChange={vi.fn()} catalog={undefined} onCreate={vi.fn()} returnFocusRef={{ current: opener }} />;
    try {
      await act(async () => root.render(sheet(true)));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(document.body.querySelector('[data-testid="new-studio-app"]')).not.toBeNull();
      expect(document.activeElement).not.toBe(opener);

      await act(async () => root.render(sheet(false)));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
      expect(document.body.querySelector('[data-testid="new-studio-app"]')).toBeNull();
      // Not the page body: the next Tab continues from where the person was.
      expect(document.activeElement).toBe(opener);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      opener.remove();
    }
  });

  it("shows a picked language's whole name on up to two lines", async () => {
    const language = { id: "html", name: "Website (HTML, CSS, JavaScript)", abbr: "HT", color: "orangered", category: "web", kind: "static", blurb: "A page with styles and a script, served as it is.", popular: true, requires: null, run: null, starterFiles: ["index.html"] };
    const catalog = { platform: "linux", categories: [{ id: "popular", label: "Popular" }], languages: [language], toolchains: [], cloudflared: false };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<NewStudioAppSheet open onOpenChange={vi.fn()} catalog={catalog as never} startWith="html" onCreate={vi.fn()} />));
      const title = [...document.body.querySelectorAll<HTMLElement>('[data-testid="studio-language-detail"] p')].find((node) => node.textContent === language.name)!;
      expect(title).toBeTruthy();
      expect(title.className).toMatch(/\bline-clamp-2\b/);
      expect(title.className).not.toMatch(/\btruncate\b|whitespace-nowrap/);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
