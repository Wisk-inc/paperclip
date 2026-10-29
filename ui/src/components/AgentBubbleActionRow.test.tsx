// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueChatFeedbackButtons } from "./AgentBubbleActionRow";

// Automa builds keep votes on the device; only a build with its own endpoint offers sharing.
const feedbackSharing = vi.hoisted(() => ({ available: false }));

vi.mock("@/lib/feedback-sharing", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/feedback-sharing")>();
  return {
    ...original,
    effectiveFeedbackSharingPreference: (preference: Parameters<typeof original.effectiveFeedbackSharingPreference>[0]) =>
      original.effectiveFeedbackSharingPreference(preference, feedbackSharing.available),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("IssueChatFeedbackButtons (task chat and conference room votes)", () => {
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

  async function voteHelpful() {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Helpful"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it.each(["prompt", "allowed"] as const)(
    "keeps a vote on the device, without asking, in a build that cannot share (%s)",
    async (sharingPreference) => {
      const onVote = vi.fn(async () => {});
      await act(async () => root.render(
        <IssueChatFeedbackButtons activeVote={null} sharingPreference={sharingPreference} termsUrl={null} onVote={onVote} />,
      ));

      await voteHelpful();

      expect(onVote).toHaveBeenCalledWith("up", {});
      expect(document.body.textContent).not.toContain("Save your feedback sharing preference");
    },
  );

  it("names Automa's maker as the one who would receive shared votes", async () => {
    feedbackSharing.available = true;
    const onVote = vi.fn(async () => {});
    await act(async () => root.render(
      <IssueChatFeedbackButtons activeVote={null} sharingPreference="prompt" termsUrl={null} onVote={onVote} />,
    ));

    await voteHelpful();

    expect(onVote).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Choose whether voted AI outputs can be shared with Corx Labs. This answer");
    expect(document.body.textContent).not.toContain("Automa Labs");
  });
});
