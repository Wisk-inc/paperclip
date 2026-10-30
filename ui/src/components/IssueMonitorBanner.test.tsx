// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IssueMonitorBanner,
  IssueMonitorComposerStrip,
  buildMonitorSurfaceCopy,
  hasVisibleMonitorSurface,
} from "./IssueMonitorBanner";
import type { DerivedMonitorState } from "@/lib/issue-monitor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-07-17T20:00:00.000Z");

function derived(overrides: Partial<DerivedMonitorState> & { state: DerivedMonitorState["state"] }): DerivedMonitorState {
  return {
    source: "monitor",
    nextCheckAt: null,
    attemptCount: 0,
    serviceName: null,
    ...overrides,
  };
}

describe("buildMonitorSurfaceCopy", () => {
  it.each(["retrying", "due-now", "overdue"] as const)("keeps workspace contention neutral when %s", (state) => {
    const copy = buildMonitorSurfaceCopy(derived({
      state, source: "scheduled-retry", nextCheckAt: NOW.toISOString(), attemptCount: 4,
    }), NOW, "workspace_busy");
    expect(copy!.bannerTitle).toBe("Waiting for workspace");
    expect(copy!.stripTitle).toBe("Waiting for workspace");
    expect(copy!.tone).toBe("info");
    expect(copy!.workspaceWait).toBe(true);
    expect(copy!.bannerMeta.join(" ")).not.toMatch(/Attempt|overdue|retry/i);
  });
  it("leads with two-unit relative time while scheduled", () => {
    const copy = buildMonitorSurfaceCopy(
      derived({
        state: "scheduled",
        nextCheckAt: new Date(NOW.getTime() + (2 * 60 + 12) * 60_000).toISOString(),
        attemptCount: 1,
        serviceName: "vercel-deploy",
      }),
      NOW,
    );

    expect(copy).not.toBeNull();
    expect(copy!.bannerTitle).toBe("Waiting on monitor — resumes in 2h 12m");
    expect(copy!.stripTitle).toBe("Resumes in 2h 12m");
    expect(copy!.tone).toBe("info");
    expect(copy!.bannerMeta).toContain("Attempt 1");
    expect(copy!.bannerMeta).toContain("Watching: vercel-deploy");
    // Absolute time carries the "(your time)" hint on the banner only.
    expect(copy!.bannerMeta.some((piece) => piece.includes("(your time)"))).toBe(true);
    expect(copy!.stripMeta.some((piece) => piece.includes("(your time)"))).toBe(false);
  });

  it("keeps the retrying attempt count visible", () => {
    const copy = buildMonitorSurfaceCopy(
      derived({
        state: "retrying",
        nextCheckAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
        attemptCount: 3,
      }),
      NOW,
    );
    expect(copy!.stripTitle).toBe("Resumes in 1h 30m");
    expect(copy!.stripMeta).toContain("Attempt 3");
  });

  it("uses agent copy for scheduled retries without a monitor", () => {
    const copy = buildMonitorSurfaceCopy(
      derived({
        state: "retrying",
        source: "scheduled-retry",
        nextCheckAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
        attemptCount: 2,
      }),
      NOW,
    );

    expect(copy!.bannerTitle).toBe("Agent resumes in 1h 30m");
    expect(copy!.stripTitle).toBe("Resumes in 1h 30m");
  });

  it("switches copy for due-now and overdue states", () => {
    const dueNow = buildMonitorSurfaceCopy(
      derived({ state: "due-now", nextCheckAt: NOW.toISOString(), attemptCount: 1 }),
      NOW,
    );
    expect(dueNow!.bannerTitle).toBe("Waiting on monitor — due now");
    expect(dueNow!.stripTitle).toBe("Due now");
    expect(dueNow!.bannerMeta).toContain("Checking momentarily…");
    expect(dueNow!.tone).toBe("info");

    const overdue = buildMonitorSurfaceCopy(
      derived({
        state: "overdue",
        nextCheckAt: new Date(NOW.getTime() - 18 * 60_000).toISOString(),
        attemptCount: 2,
      }),
      NOW,
    );
    expect(overdue!.bannerTitle).toBe("Waiting on monitor — overdue by 18m");
    expect(overdue!.stripTitle).toBe("Overdue by 18m");
    expect(overdue!.bannerMeta).toContain("Fires on next tick");
    expect(overdue!.tone).toBe("warning");
  });

  it("says a reply waits for a scheduled retry, and wakes the agent only while a monitor waits", () => {
    const retry = buildMonitorSurfaceCopy(
      derived({ state: "retrying", source: "scheduled-retry", nextCheckAt: new Date(NOW.getTime() + 14_000).toISOString(), attemptCount: 2 }),
      NOW,
    );
    expect(retry!.retry).toBe(true);
    expect(retry!.stripTitle).toBe("Resumes in 14s");
    expect(retry!.replyHint).toBe("Replies wait for this retry; the agent reads them when it resumes.");

    const monitor = buildMonitorSurfaceCopy(
      derived({ state: "scheduled", nextCheckAt: new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString() }),
      NOW,
    );
    expect(monitor!.retry).toBe(false);
    expect(monitor!.replyHint).toBe("Sending a reply wakes the agent now — before the scheduled check.");

    // A monitor with a retry also pending: the retry still holds replies.
    const both = buildMonitorSurfaceCopy(
      derived({ state: "scheduled", nextCheckAt: new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString() }),
      NOW,
      null,
      { retryPending: true },
    );
    expect(both!.retry).toBe(true);
    expect(both!.replyHint).not.toContain("wakes the agent now");
  });

  it("hides both surfaces when cleared, none, or without a next check", () => {
    expect(buildMonitorSurfaceCopy(derived({ state: "cleared", attemptCount: 2 }), NOW)).toBeNull();
    expect(buildMonitorSurfaceCopy(derived({ state: "none" }), NOW)).toBeNull();
    // A "scheduled" state with no timestamp cannot render an ETA — hide.
    expect(buildMonitorSurfaceCopy(derived({ state: "scheduled", nextCheckAt: null }), NOW)).toBeNull();
  });
});

describe("IssueMonitorBanner / IssueMonitorComposerStrip rendering", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  function retryingIssue(id: string, inMs: number, attempt = 2): Issue {
    return {
      id,
      status: "in_progress",
      scheduledRetry: {
        status: "scheduled_retry",
        scheduledRetryAt: new Date(NOW.getTime() + inMs).toISOString(),
        scheduledRetryAttempt: attempt,
      },
    } as Issue;
  }

  it("offers Retry now, not the monitor check, while a scheduled retry holds the task", () => {
    const onCheckNow = vi.fn();
    const onRetryNow = vi.fn();
    const root = createRoot(container);
    flushSync(() => root.render(
      <>
        <IssueMonitorBanner issue={retryingIssue("issue-1", 14_000)} onCheckNow={onCheckNow} onRetryNow={onRetryNow} />
        <IssueMonitorComposerStrip issue={retryingIssue("issue-1", 14_000)} onCheckNow={onCheckNow} onRetryNow={onRetryNow} />
      </>,
    ));

    expect(container.textContent).toContain("Resumes in 14s");
    expect(container.textContent).toContain("Attempt 2");
    expect(container.textContent).toContain("Replies wait for this retry");
    expect(container.textContent).not.toContain("wakes the agent now");
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.some((button) => button.textContent?.includes("Check now"))).toBe(false);
    const retryButtons = buttons.filter((button) => button.textContent?.includes("Retry now"));
    expect(retryButtons).toHaveLength(2);
    act(() => retryButtons[1]!.click());
    expect(onRetryNow).toHaveBeenCalledTimes(1);
    expect(onCheckNow).not.toHaveBeenCalled();
    flushSync(() => root.unmount());
  });

  it("closes the banner and the strip with the X for the rest of the wait, then shows the next one", () => {
    const root = createRoot(container);
    const render = (issue: Issue) => act(() => root.render(
      <>
        <IssueMonitorBanner issue={issue} />
        <IssueMonitorComposerStrip issue={issue} />
      </>,
    ));
    const waiting = retryingIssue("issue-2", 30_000);
    render(waiting);
    const closeButtons = container.querySelectorAll<HTMLButtonElement>("[data-testid='wait-notice-dismiss']");
    expect(closeButtons).toHaveLength(2);
    expect(closeButtons[0]!.getAttribute("aria-label")).toBe("Hide this notice");

    act(() => closeButtons[1]!.click());
    expect(container.textContent).toBe("");

    // The retry runs, fails, and schedules attempt 3: still closed.
    render({ ...waiting, scheduledRetry: { ...waiting.scheduledRetry!, status: "running" } });
    render(retryingIssue("issue-2", 60_000, 3));
    expect(container.textContent).toBe("");

    // The wait ends; a later wait shows again.
    render({ ...waiting, scheduledRetry: null });
    render(retryingIssue("issue-2", 5 * 60_000, 1));
    expect(container.textContent).toContain("Resumes in 5m");
    act(() => root.unmount());
  });

  it("fetches the task again while the wait is due, and stops once the retry starts", () => {
    const onDue = vi.fn();
    const due = retryingIssue("issue-3", 0, 1);
    const root = createRoot(container);
    act(() => root.render(<IssueMonitorBanner issue={due} onDue={onDue} />));
    expect(container.textContent).toContain("Agent retry due now");
    expect(onDue).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(onDue).toHaveBeenCalledTimes(2);

    act(() => root.render(<IssueMonitorBanner issue={{ ...due, scheduledRetry: { ...due.scheduledRetry!, status: "running" } }} onDue={onDue} />));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDue).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
    act(() => root.unmount());
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  function issueWithMonitor(nextCheckAt: string | null): Issue {
    return {
      executionState: nextCheckAt
        ? { monitor: { status: "scheduled", nextCheckAt, attemptCount: 1, serviceName: "vercel-deploy" } }
        : null,
      scheduledRetry: null,
    } as unknown as Issue;
  }

  it("explains automatic workspace waiting without promising that a reply bypasses the lock", () => {
    const issue = {
      status: "todo", scheduledRetry: { status: "scheduled_retry", scheduledRetryReason: "workspace_busy", scheduledRetryAt: NOW.toISOString() },
    } as Issue;
    const root = createRoot(container);
    flushSync(() => root.render(<><IssueMonitorBanner issue={issue} onCheckNow={vi.fn()} /><IssueMonitorComposerStrip issue={issue} onCheckNow={vi.fn()} /></>));
    expect(container.textContent).toContain("Waiting for workspace");
    expect(container.textContent).toContain("You can keep sending instructions while the agent waits.");
    expect(container.textContent).not.toContain("wakes the agent now");
    expect(container.querySelector("button")).toBeNull();
    flushSync(() => root.unmount());
  });

  it("renders the banner with a working Check now button while waiting", () => {
    const onCheckNow = vi.fn();
    expect(hasVisibleMonitorSurface(issueWithMonitor(new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString()))).toBe(true);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <IssueMonitorBanner
          issue={issueWithMonitor(new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString())}
          onCheckNow={onCheckNow}
        />,
      );
    });

    expect(container.textContent).toContain("Waiting on monitor — resumes in 2h");
    expect(container.textContent).toContain("Watching: vercel-deploy");

    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Check now"),
    );
    expect(button).toBeTruthy();
    flushSync(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCheckNow).toHaveBeenCalledTimes(1);

    flushSync(() => root.unmount());
  });

  it("hides the banner and strip when there is no monitor", () => {
    expect(hasVisibleMonitorSurface(issueWithMonitor(null))).toBe(false);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <>
          <IssueMonitorBanner issue={issueWithMonitor(null)} onCheckNow={vi.fn()} />
          <IssueMonitorComposerStrip issue={issueWithMonitor(null)} onCheckNow={vi.fn()} />
        </>,
      );
    });
    expect(container.textContent).toBe("");
    flushSync(() => root.unmount());
  });

  it("renders the composer strip with the reply-wakes-agent hint", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <IssueMonitorComposerStrip
          issue={issueWithMonitor(new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString())}
          onCheckNow={vi.fn()}
        />,
      );
    });

    expect(container.querySelector("[data-testid='issue-monitor-composer-strip']")).toBeTruthy();
    expect(container.textContent).toContain("Resumes in 2h");
    expect(container.textContent).toContain("Sending a reply wakes the agent now");

    flushSync(() => root.unmount());
  });

  it("removes both countdowns and Check now when the retry starts, then shows a newly scheduled retry", () => {
    const root = createRoot(container);
    const issue = {
      status: "in_progress",
      scheduledRetry: {
        status: "scheduled_retry",
        scheduledRetryAt: new Date(NOW.getTime() - 2 * 60_000).toISOString(),
        scheduledRetryAttempt: 1,
      },
    } as Issue;
    const render = (next: Issue) => flushSync(() => root.render(
      <>
        <IssueMonitorBanner issue={next} onCheckNow={vi.fn()} />
        <IssueMonitorComposerStrip issue={next} onCheckNow={vi.fn()} />
      </>,
    ));

    render(issue);
    expect(container.textContent).toContain("Overdue by 2m");

    for (const status of ["queued", "running"] as const) {
      const promoted = { ...issue, scheduledRetry: { ...issue.scheduledRetry!, status } };
      render(promoted);
      expect(hasVisibleMonitorSurface(promoted)).toBe(false);
      expect(container.textContent).toBe("");
      expect(container.querySelector("button")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    }

    render({ ...issue, scheduledRetry: { ...issue.scheduledRetry!, scheduledRetryAt: new Date(NOW.getTime() + 5 * 60_000).toISOString() } });
    expect(container.textContent).toContain("Resumes in 5m");

    render({ ...issue, status: "done" });
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    flushSync(() => root.unmount());
  });
});
