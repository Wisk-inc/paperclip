// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StudioRunState } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyMock = vi.hoisted(() => vi.fn(async (_text: string) => undefined));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: copyMock }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));
vi.mock("../mascot/Mascot", () => ({ Mascot: () => null }));

import { StudioPreview } from "./StudioPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PUBLIC_URL = "https://island-weather.trycloudflare.com";

function runState(overrides: Partial<StudioRunState> = {}): StudioRunState {
  return {
    status: "running",
    command: "npx serve",
    port: 43049,
    previewPath: "/preview/ws-1/",
    previewReady: true,
    startedAt: new Date().toISOString(),
    endedAt: null,
    publicUrl: null,
    tunnelStatus: "off",
    tunnelError: null,
    ...overrides,
  } as StudioRunState;
}

type PublicLink = NonNullable<Parameters<typeof StudioPreview>[0]["publicLink"]>;

describe("StudioPreview public link", () => {
  let container: HTMLDivElement;
  let root: Root;
  let publicLink: { [K in keyof PublicLink]: PublicLink[K] };

  beforeEach(() => {
    copyMock.mockClear();
    // The popover measures its button to place itself.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    publicLink = {
      cloudflaredInstalled: true,
      onOpen: vi.fn(async () => undefined),
      onClose: vi.fn(async () => undefined),
      onInstall: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const draw = async (run: StudioRunState | null, props: Partial<Parameters<typeof StudioPreview>[0]> = {}) => {
    await act(async () =>
      root.render(<StudioPreview run={run} consoleApp={false} onRun={vi.fn()} onShowConsole={vi.fn()} publicLink={publicLink} {...props} />),
    );
  };
  const button = () => container.querySelector<HTMLButtonElement>('[data-testid="studio-public-link-button"]');
  // The popover is drawn at the end of the page, the link strip inside the preview.
  const controls = () => document.querySelector<HTMLElement>('[data-testid="studio-public-link"]');
  const tap = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      (element as HTMLElement).click();
    });
  };

  it("takes no room under the preview until there is a public link: a button in the address row opens it", async () => {
    await draw(runState());
    expect(controls()).toBeNull();
    const trigger = button()!;
    expect(trigger.getAttribute("aria-label")).toBe("Public link");
    // In the address row, beside reload and open in a new tab.
    const row = container.querySelector('[data-testid="studio-preview-address"]')!.parentElement!;
    expect(trigger.parentElement).toBe(row);
    expect(row.querySelector('[aria-label="Reload preview"]')).not.toBeNull();
    // Nothing follows the app itself.
    expect(container.querySelector('[data-testid="studio-preview-frame"]')!.parentElement!.nextElementSibling).toBeNull();

    await tap(trigger);
    const popover = controls()!;
    expect(popover.getAttribute("data-slot")).toBe("popover-content");
    expect(container.contains(popover)).toBe(false);
    expect(popover.textContent).toContain("Get a public link");
    expect(popover.textContent).toContain("A free Cloudflare link to this app, hosted from this device. It ends when the app stops.");

    const get = [...popover.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Get a public link"))!;
    await act(async () => get.click());
    expect(publicLink.onOpen).toHaveBeenCalledTimes(1);
    expect(publicLink.onInstall).not.toHaveBeenCalled();
  });

  it("offers to set public links up when the tunnel is not installed, and says why one could not be made", async () => {
    publicLink.cloudflaredInstalled = false;
    await draw(runState({ tunnelStatus: "failed", tunnelError: "The tunnel closed before it gave a link." }));
    // The button shows there is something wrong before it is opened.
    expect(button()!.className.split(/\s+/)).toContain("text-destructive");
    await tap(button()!);
    const popover = controls()!;
    expect(popover.textContent).toContain("Installs Cloudflare's free tunnel (cloudflared) so you can share a link to your running app.");
    expect(popover.textContent).toContain("The tunnel closed before it gave a link.");
    const setUp = [...popover.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Set up public links"))!;
    await act(async () => setUp.click());
    expect(publicLink.onInstall).toHaveBeenCalledTimes(1);
    expect(publicLink.onOpen).not.toHaveBeenCalled();
  });

  it("waits while a link is being made", async () => {
    await draw(runState({ tunnelStatus: "starting" }));
    expect(button()!.querySelector(".animate-spin")).not.toBeNull();
    await tap(button()!);
    const get = [...controls()!.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Get a public link"))!;
    expect(get.disabled).toBe(true);
  });

  it("shows the link on one row with Copy and Close while it exists, and no button", async () => {
    await draw(runState({ publicUrl: PUBLIC_URL, tunnelStatus: "on" }));
    expect(button()).toBeNull();
    const strip = controls()!;
    expect(container.contains(strip)).toBe(true);
    const link = strip.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe(PUBLIC_URL);
    expect(link.textContent).toBe(PUBLIC_URL);
    expect(link.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "truncate"]));
    // One row: the link and its two buttons share a parent, and nothing else is in the strip.
    const copy = strip.querySelector<HTMLButtonElement>('button[aria-label="Copy public link"]')!;
    const close = strip.querySelector<HTMLButtonElement>('button[aria-label="Close public link"]')!;
    expect(copy.parentElement).toBe(link.parentElement);
    expect(close.parentElement).toBe(link.parentElement);
    expect(strip.children).toHaveLength(1);
    expect(strip.querySelector("p")).toBeNull();

    await act(async () => copy.click());
    expect(copyMock).toHaveBeenCalledWith(PUBLIC_URL);
    await act(async () => close.click());
    expect(publicLink.onClose).toHaveBeenCalledTimes(1);
  });

  it("has no public link controls for a collaborator or a console app", async () => {
    await draw(runState(), { publicLink: undefined });
    expect(button()).toBeNull();
    expect(controls()).toBeNull();
    await draw(runState(), { consoleApp: true });
    expect(button()).toBeNull();
    expect(controls()).toBeNull();
  });
});
