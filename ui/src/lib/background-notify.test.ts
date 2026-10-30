// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askForNotificationsOnce,
  handleServiceWorkerMessage,
  hasWatchedIssues,
  noteRunOutcomeSeen,
  notifyRunOutcomeWhenAway,
  notifyWhenAway,
  plainSnippet,
  resetBackgroundNotifyForTests,
  runOutcomeNotice,
  setNotificationPathOpener,
  showingIssue,
  studioReplyNotice,
  watchIssueReplies,
  watchedIssuePath,
} from "./background-notify";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

function installBridge() {
  const bridge = {
    getInfo: vi.fn(() => "{}"),
    notify: vi.fn(),
    requestNotifications: vi.fn(),
  };
  (window as unknown as { AutomaNative: unknown }).AutomaNative = bridge;
  window.__automaKey = "page-key";
  return bridge;
}

beforeEach(() => {
  resetBackgroundNotifyForTests();
  localStorage.clear();
  sessionStorage.clear();
  setVisibility("visible");
});

afterEach(() => {
  delete (window as unknown as { AutomaNative?: unknown }).AutomaNative;
  delete window.__automaKey;
  setNotificationPathOpener(null);
});

describe("finished-run wording", () => {
  it("says who replied and quotes the reply, or why the run stopped", () => {
    expect(runOutcomeNotice({ runId: "r1", issueId: "i1", status: "succeeded", finalText: "Done: the **page** is live." }, "Ada", "/ACME/chats/ada")).toEqual({
      title: "Ada replied",
      body: "Done: the **page** is live.",
      path: "/ACME/chats/ada",
      tag: "issue:i1",
      key: "run:r1",
    });
    expect(runOutcomeNotice({ runId: "r2", issueId: "i1", status: "succeeded" }, null, "/issues/i1")?.title).toBe("Your agent finished");
    expect(runOutcomeNotice({ runId: "r3", issueId: "i1", status: "failed", error: "Out of credits" }, "Ada", "/issues/i1")).toMatchObject({
      title: "Ada couldn't finish",
      body: "Out of credits",
    });
    expect(runOutcomeNotice({ runId: "r4", issueId: "i1", status: "timed_out" }, "Ada", "/issues/i1")?.body).toBe("It ran out of time.");
    // Stopped by the person, or still going: nothing to tell.
    expect(runOutcomeNotice({ runId: "r5", issueId: "i1", status: "cancelled" }, "Ada", "/issues/i1")).toBeNull();
    expect(runOutcomeNotice({ runId: "r6", issueId: "i1", status: "running" }, "Ada", "/issues/i1")).toBeNull();
  });

  it("strips Markdown for the notification text", () => {
    expect(plainSnippet("## Done\n\nSee [the page](http://x) and `npm start`.\n```js\nlong()\n```")).toBe("Done See the page and npm start.");
    expect(plainSnippet("a".repeat(300), 50)).toHaveLength(50);
  });
});

describe("notifyWhenAway", () => {
  it("stays quiet while the page is on screen, then posts once through the app when it is hidden", () => {
    const bridge = installBridge();
    const notice = { title: "Ada replied", body: "**Done**", path: "/issues/i1", tag: "issue:i1", key: "run:r1" };
    expect(notifyWhenAway(notice)).toBe(false);
    setVisibility("hidden");
    // Already handled while visible: a repeat of the same status does not alert later.
    expect(notifyWhenAway(notice)).toBe(false);
    expect(notifyWhenAway({ ...notice, key: "run:r2" })).toBe(true);
    expect(bridge.notify).toHaveBeenCalledWith("page-key", "Ada replied", "Done", "/issues/i1", "issue:i1");
    expect(notifyWhenAway({ ...notice, key: "run:r2" })).toBe(false);
    expect(bridge.notify).toHaveBeenCalledTimes(1);
  });

  it("uses a browser notification only when the person allowed them", () => {
    setVisibility("hidden");
    const shown: Array<{ title: string; options: NotificationOptions }> = [];
    class FakeNotification {
      static permission: NotificationPermission = "denied";
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions) {
        shown.push({ title, options });
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    try {
      expect(notifyWhenAway({ title: "Ada replied", path: "/issues/i1", tag: "issue:i1", key: "run:a" })).toBe(false);
      FakeNotification.permission = "granted";
      expect(notifyWhenAway({ title: "Ada replied", path: "/issues/i1", tag: "issue:i1", key: "run:b" })).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("watched tasks", () => {
  it("notifies about the task on screen and tasks the person wrote to, until the watch runs out", () => {
    const bridge = installBridge();
    setVisibility("hidden");
    const nameOf = () => "Ada";
    const stop = showingIssue("open", "/ACME/chats/ada");
    expect(hasWatchedIssues()).toBe(true);
    expect(notifyRunOutcomeWhenAway({ runId: "r1", issueId: "open", status: "succeeded", agentId: "a1", finalText: "Hi" }, nameOf)).toBe(true);
    expect(bridge.notify).toHaveBeenLastCalledWith("page-key", "Ada replied", "Hi", "/ACME/chats/ada", "issue:open");
    stop();
    // Other tasks' runs (the agents' own routine work) never notify.
    expect(notifyRunOutcomeWhenAway({ runId: "r2", issueId: "other", status: "succeeded", agentId: "a1" }, nameOf)).toBe(false);

    const now = Date.now();
    watchIssueReplies("asked", "/ACME/issues/ACME-4", now);
    expect(watchedIssuePath("asked", now + 60_000)).toBe("/ACME/issues/ACME-4");
    expect(watchedIssuePath("asked", now + 7 * 60 * 60 * 1000)).toBeNull();
    expect(hasWatchedIssues(now + 7 * 60 * 60 * 1000)).toBe(false);
  });

  it("never announces a reply the person already saw, or an old outcome sent again", () => {
    const bridge = installBridge();
    showingIssue("open", "/ACME/chats/ada");
    const nameOf = () => "Ada";
    // Arrived while the person was looking; the server sends it again after they leave.
    noteRunOutcomeSeen({ runId: "seen", issueId: "open", status: "succeeded" });
    setVisibility("hidden");
    expect(notifyRunOutcomeWhenAway({ runId: "seen", issueId: "open", status: "succeeded" }, nameOf)).toBe(false);
    // Finished long ago (a replay after a restart): not news.
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    expect(notifyRunOutcomeWhenAway({ runId: "old", issueId: "open", status: "succeeded", finishedAt: "2026-10-30T11:40:00.000Z" }, nameOf, now)).toBe(false);
    expect(notifyRunOutcomeWhenAway({ runId: "new", issueId: "open", status: "succeeded", finishedAt: "2026-10-30T11:59:30.000Z" }, nameOf, now)).toBe(true);
    expect(bridge.notify).toHaveBeenCalledTimes(1);
  });

  it("keeps the watches across a reload of the tab", () => {
    watchIssueReplies("asked", "/ACME/issues/ACME-4");
    resetBackgroundNotifyForTests();
    // The reset clears memory only; the tab's session storage still has the watch.
    expect(watchedIssuePath("asked")).toBe("/ACME/issues/ACME-4");
  });
});

describe("opening the screen a notification names", () => {
  it("follows the service worker's message to board paths only", () => {
    const opened: string[] = [];
    setNotificationPathOpener((path) => opened.push(path));
    expect(handleServiceWorkerMessage({ type: "automa:open-path", path: "/ACME/studio/w1" })).toBe(true);
    expect(handleServiceWorkerMessage({ type: "automa:open-path", path: "//evil.example" })).toBe(false);
    expect(handleServiceWorkerMessage({ type: "other", path: "/x" })).toBe(false);
    expect(opened).toEqual(["/ACME/studio/w1"]);
  });

  it("words App Studio replies with the project and the reply", () => {
    expect(studioReplyNotice({ workspaceId: "w1", turnId: "t1", projectName: "Todo", text: "Built the page.", error: null, path: "/ACME/studio/w1" })).toEqual({
      title: "App Studio · Todo",
      body: "Built the page.",
      path: "/ACME/studio/w1",
      tag: "studio:w1",
      key: "studio-turn:t1",
    });
    expect(studioReplyNotice({ workspaceId: "w1", turnId: "t2", projectName: null, text: "", error: "Model offline", path: "/s" }).body).toBe("Couldn't finish: Model offline");
  });
});

describe("askForNotificationsOnce", () => {
  it("asks the app once, never again after that", () => {
    const bridge = installBridge();
    askForNotificationsOnce();
    askForNotificationsOnce();
    expect(bridge.requestNotifications).toHaveBeenCalledTimes(1);
    expect(bridge.requestNotifications).toHaveBeenCalledWith("page-key");
  });
});
