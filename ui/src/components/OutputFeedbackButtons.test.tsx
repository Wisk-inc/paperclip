// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutputFeedbackButtons } from "./OutputFeedbackButtons";

// Automa builds keep votes on the device; only a build with its own endpoint offers sharing.
const feedbackSharing = vi.hoisted(() => ({ available: false }));

vi.mock("../lib/feedback-sharing", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/feedback-sharing")>();
  return {
    ...original,
    effectiveFeedbackSharingPreference: (preference: Parameters<typeof original.effectiveFeedbackSharingPreference>[0]) =>
      original.effectiveFeedbackSharingPreference(preference, feedbackSharing.available),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("OutputFeedbackButtons", () => {
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
    feedbackSharing.available = false;
  });

  function clickHelpful() {
    const helpful = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Helpful"));
    return act(async () => {
      helpful?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("keeps a vote on the device, without asking, in a build that cannot share", async () => {
    const onVote = vi.fn(async () => {});
    await act(async () => root.render(<OutputFeedbackButtons sharingPreference="allowed" onVote={onVote} />));

    await clickHelpful();

    expect(onVote).toHaveBeenCalledWith("up", {});
    expect(document.body.textContent).not.toContain("Save your feedback sharing preference");
  });

  it("names Automa's maker as the one who would receive shared votes", async () => {
    feedbackSharing.available = true;
    const onVote = vi.fn(async () => {});
    await act(async () => root.render(<OutputFeedbackButtons sharingPreference="prompt" onVote={onVote} />));

    await clickHelpful();

    expect(onVote).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Choose whether voted AI outputs can be shared with Corx Labs. This answer");
    expect(document.body.textContent).not.toContain("Automa Labs");
  });
});
