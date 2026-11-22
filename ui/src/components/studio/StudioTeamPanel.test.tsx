// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StudioChangeRequest } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioTeamPanel, expiryOptionFor, type StudioAcceptResult } from "./StudioTeamPanel";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, onChange, path }: { value: string; onChange?: (value: string) => void; path: string }) => (
    <textarea aria-label={`Edit ${path}`} value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));
vi.mock("./StudioDiffView", () => ({
  StudioDiffView: ({ files }: { files: Array<{ path: string; after: string | null }> }) => (
    <pre data-testid="diff">{files.map((file) => `${file.path}: ${file.after}`).join("\n")}</pre>
  ),
}));
vi.mock("./StudioChat", () => ({ StudioChat: () => null }));
vi.mock("../mascot/Mascot", () => ({ Mascot: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const change = {
  id: "change-1",
  workspaceId: "ws-1",
  collaboratorId: "c-1",
  authorName: "Sam",
  message: null,
  status: "open",
  files: [{ path: "app.py", before: "print(0)\n", after: "print(1)\n" }],
  createdAt: new Date().toISOString(),
  resolvedAt: null,
} as unknown as StudioChangeRequest;

let root: Root;
let container: HTMLDivElement;
let onAccept: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<StudioAcceptResult>>>;

function button(text: string) {
  return [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(text));
}

async function openReview() {
  await act(async () => {
    root.render(
      <StudioTeamPanel
        shareEnabled
        shareCode="ABCD2345"
        shareExpiresAt={null}
        share={null}
        participants={[]}
        collaborators={[]}
        messages={[]}
        changeRequests={[change]}
        onShare={vi.fn()}
        onStopSharing={vi.fn()}
        onRemoveCollaborator={vi.fn()}
        onSendMessage={vi.fn()}
        fileUrl={() => ""}
        onAddToProject={vi.fn()}
        onAccept={onAccept}
        onReject={vi.fn()}
      />,
    );
  });
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid=studio-change-row]")!.click());
}

describe("Reviewing a collaborator's change", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onAccept = vi.fn(async () => "accepted" as StudioAcceptResult);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the owner's edits after switching back to the diff, and accepts those", async () => {
    await openReview();
    await act(async () => button("Edit")!.click());
    const editor = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Edit app.py']")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(editor, "print(2)\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Back to the diff: it shows the owner's version, and Accept says so.
    await act(async () => button("Diff")!.click());
    expect(container.querySelector("[data-testid=diff]")?.textContent).toContain("app.py: print(2)");
    expect(button("Accept edited")).toBeDefined();

    await act(async () => button("Accept edited")!.click());
    expect(onAccept).toHaveBeenCalledWith("change-1", [{ path: "app.py", before: "print(0)\n", after: "print(2)\n" }], undefined);
  });

  it("asks before replacing newer edits, and replaces them only when told", async () => {
    onAccept.mockResolvedValueOnce({ stalePaths: ["app.py"] });
    await openReview();
    await act(async () => button("Accept")!.click());
    // Still on the review, asking.
    const notice = container.querySelector("[data-testid=studio-change-stale]");
    expect(notice?.textContent).toContain("app.py changed after Sam made this change");

    await act(async () => container.querySelector<HTMLButtonElement>("[data-testid=studio-change-overwrite]")!.click());
    expect(onAccept).toHaveBeenLastCalledWith("change-1", undefined, { overwriteNewer: true });
    // Accepted: back to the list.
    expect(container.querySelector("[data-testid=studio-change-stale]")).toBeNull();
    expect(container.querySelector("[data-testid=studio-change-row]")).not.toBeNull();
  });

  it("stays on the review when accepting failed", async () => {
    onAccept.mockResolvedValueOnce("failed");
    await openReview();
    await act(async () => button("Accept")!.click());
    expect(container.querySelector("[data-testid=studio-change-accept]")).not.toBeNull();
  });
});

describe("The share card", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderSharing(shareExpiresAt: string | null, onShare = vi.fn(async () => undefined), publicError: string | null = "cloudflared is not installed") {
    await act(async () => {
      root.render(
        <StudioTeamPanel
          shareEnabled
          shareCode="ABCD2345"
          shareExpiresAt={shareExpiresAt}
          share={{ code: "ABCD2345", inviteUrl: null, localInviteUrl: "http://127.0.0.1:41000/studio-guest/?code=ABCD2345", publicError }}
          participants={[]}
          collaborators={[]}
          messages={[]}
          changeRequests={[]}
          onShare={onShare}
          onStopSharing={vi.fn()}
          onRemoveCollaborator={vi.fn()}
          onSendMessage={vi.fn()}
          fileUrl={() => ""}
          onAddToProject={vi.fn()}
          onAccept={vi.fn()}
          onReject={vi.fn()}
        />,
      );
    });
    return onShare;
  }

  it("shows the saved expiry, and a new code keeps it", async () => {
    const onShare = await renderSharing(null);
    expect(container.querySelector("[data-testid=studio-expiry-never]")?.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("[data-testid=studio-expiry-24]")?.getAttribute("aria-checked")).toBe("false");
    await act(async () => container.querySelector<HTMLButtonElement>("[data-testid=studio-new-code]")!.click());
    expect(onShare).toHaveBeenCalledWith({ newCode: true, expiresInHours: null });
  });

  it("says the local link works on this device only, and why there is no public one", async () => {
    await renderSharing(new Date(Date.now() + 3 * 24 * 3_600_000).toISOString());
    expect(container.textContent).toContain("Invite link (this device only)");
    expect(container.textContent).not.toContain("this network");
    expect(container.textContent).toContain("couldn't be made: cloudflared is not installed");
    expect(container.querySelector("[data-testid=studio-expiry-168]")?.getAttribute("aria-checked")).toBe("true");
  });

  it("ends the note about the local link with one period, whatever the reason ends with", async () => {
    const note = () => container.querySelector("[data-testid=studio-invite-local-note]")!.textContent;
    // The reason as the server sends it: two sentences, the last one closed.
    await renderSharing(null, undefined, "cloudflared is not installed on this device. Install it to get a public link.");
    expect(note()).toBe(
      "This link opens only on the device running Automa. Friends elsewhere need the public link, which couldn't be made: cloudflared is not installed on this device. Install it to get a public link.",
    );
    await renderSharing(null, undefined, "the tunnel closed... \n");
    expect(note()).toMatch(/couldn't be made: the tunnel closed\.$/);
    await renderSharing(null, undefined, "cloudflared is not installed");
    expect(note()).toMatch(/couldn't be made: cloudflared is not installed\.$/);
    await renderSharing(null, undefined, null);
    expect(note()).toBe("This link opens only on the device running Automa. Friends elsewhere need the public link.");
  });

  it("offers the public link again where only the link for this device is at hand, keeping the code and its expiry", async () => {
    // A page opened again after Automa restarted: the code is the same, the public link is gone.
    const onShare = await renderSharing(new Date(Date.now() + 3 * 24 * 3_600_000).toISOString(), undefined, null);
    const again = container.querySelector<HTMLButtonElement>("[data-testid=studio-public-invite]")!;
    expect(again.textContent).toBe("Get the public link");
    await act(async () => again.click());
    // Nothing about the code or the expiry is sent: the server keeps both.
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onShare).toHaveBeenCalledWith({});

    await renderSharing(null, undefined, "cloudflared is not installed");
    expect(container.querySelector("[data-testid=studio-public-invite]")!.textContent).toBe("Try the public link again");
  });

  it("gives Copy invite link a thumb-sized target on touch screens", async () => {
    await renderSharing(null);
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy invite link (this device only)"]')!;
    // 24 px for a mouse, 40 px under a finger: it is the card's main action.
    expect(copy.className.split(/\s+/)).toEqual(expect.arrayContaining(["size-6", "pointer-coarse:size-10", "shrink-0"]));
    // The link keeps what room is left and is cut with an ellipsis, not the button.
    expect(container.querySelector("[data-testid=studio-invite-link]")!.className).toContain("truncate");
  });
});

describe("expiryOptionFor", () => {
  const now = Date.parse("2026-11-01T12:00:00.000Z");
  const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  it("finds the option a saved expiry came from", () => {
    expect(expiryOptionFor(null, now)).toBeNull();
    expect(expiryOptionFor(inHours(0.6), now)).toBe(1);
    expect(expiryOptionFor(inHours(20), now)).toBe(24);
    expect(expiryOptionFor(inHours(24 * 4), now)).toBe(24 * 7);
    expect(expiryOptionFor(inHours(24 * 29), now)).toBe(24 * 30);
    // Longer than any option (set some other way): the longest.
    expect(expiryOptionFor(inHours(24 * 80), now)).toBe(24 * 30);
  });
});

