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

  async function renderSharing(shareExpiresAt: string | null, onShare = vi.fn(async () => undefined)) {
    await act(async () => {
      root.render(
        <StudioTeamPanel
          shareEnabled
          shareCode="ABCD2345"
          shareExpiresAt={shareExpiresAt}
          share={{ code: "ABCD2345", inviteUrl: null, localInviteUrl: "http://127.0.0.1:41000/studio-guest/?code=ABCD2345", publicError: "cloudflared is not installed" }}
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

