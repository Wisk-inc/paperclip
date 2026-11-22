// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StudioMessage } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioChat } from "./StudioChat";

vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LONG_LINK = `https://example.com/a/very/long/url/that/does/not/break/${"a".repeat(96)}`;

function message(id: string, authorType: "owner" | "guest", body: string): StudioMessage {
  return {
    id,
    workspaceId: "ws-1",
    authorType,
    collaboratorId: authorType === "guest" ? "c-1" : null,
    authorName: authorType === "guest" ? "Sam" : "Owner",
    body,
    attachment: null,
    createdAt: new Date().toISOString(),
  } as unknown as StudioMessage;
}

describe("StudioChat", () => {
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
  });

  it("keeps a message with a long link inside the chat, from this side and from the other", async () => {
    await act(async () =>
      root.render(
        <StudioChat
          messages={[message("m-1", "owner", `Here is the page: ${LONG_LINK}`), message("m-2", "guest", `And mine: ${LONG_LINK}`)]}
          me={{ type: "owner" }}
          onSend={vi.fn()}
          fileUrl={() => ""}
        />,
      ),
    );
    const bubbles = [...container.querySelectorAll<HTMLElement>('[data-testid="studio-chat-bubble"]')];
    expect(bubbles.map((bubble) => bubble.textContent)).toEqual([`Here is the page: ${LONG_LINK}`, `And mine: ${LONG_LINK}`]);
    for (const bubble of bubbles) {
      // The bubble is never wider than its row (85% of the log), and the link breaks inside it.
      // Without the cap it grew to the link's width and ran off the screen.
      const classes = bubble.className.split(/\s+/);
      expect(classes).toContain("max-w-full");
      expect(classes).toContain("break-words");
      const row = bubble.closest("li")!.className.split(/\s+/);
      expect(row).toContain("max-w-(--sz-85pct)");
      expect(row).toContain("min-w-0");
    }
    // Mine on the right, the other person's on the left under their name.
    expect(bubbles[0]!.closest("li")!.className).toContain("self-end");
    expect(bubbles[1]!.closest("li")!.className).toContain("self-start");
    expect(bubbles[1]!.closest("li")!.textContent).toContain("Sam");
  });
});
