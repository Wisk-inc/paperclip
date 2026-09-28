// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordSupportLink } from "./DiscordSupportLink";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(ui));
  return container.querySelector<HTMLAnchorElement>('[data-slot="discord-support"]')!;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

describe("DiscordSupportLink", () => {
  it("opens the Automa support server from the Discord logo", async () => {
    const link = await render(<DiscordSupportLink />);
    expect(link.getAttribute("href")).toBe("https://discord.gg/NfnSrFK7YM");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(link.getAttribute("aria-label")).toBe("Get help on Discord");
    expect(link.querySelector("img")?.getAttribute("src")).toBe("/brands/support/discord-blurple.svg");
  });

  it("labels the Home card", async () => {
    const link = await render(<DiscordSupportLink variant="card" />);
    expect(link.getAttribute("href")).toBe("https://discord.gg/NfnSrFK7YM");
    expect(link.textContent).toContain("Get help on Discord");
  });
});
