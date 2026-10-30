// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioPageReport } from "@paperclipai/shared";
import { StudioPageProbe } from "./StudioPageProbe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const report: StudioPageReport = {
  title: "To-do",
  path: "/about",
  viewport: { width: 390, height: 844 },
  page: { width: 390, height: 900 },
  outline: ['h1 "About" 358x38 at (16,24)'],
  problems: [],
  warnings: [],
};

describe("StudioPageProbe", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function open(onDone: (report: StudioPageReport | null) => void) {
    await act(async () =>
      root.render(<StudioPageProbe previewPath="/api/studio-preview/tok/" request={{ requestId: "r1", viewport: "phone", path: "/about" }} onDone={onDone} />),
    );
    const frame = container.querySelector<HTMLIFrameElement>('[data-testid="studio-page-probe"]')!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    return { frame, post };
  }

  function answer(source: Window | null, data: unknown) {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  }

  it("opens the page out of sight at the asked size, asks it once its scripts ran, and passes its report on", async () => {
    const onDone = vi.fn();
    const { frame, post } = await open(onDone);
    expect(frame.getAttribute("src")).toBe("/api/studio-preview/tok/about");
    expect(frame.style.width).toBe("390px");
    expect(frame.style.height).toBe("844px");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("aria-hidden")).toBe("true");

    await act(async () => {
      frame.dispatchEvent(new Event("load"));
      vi.advanceTimersByTime(1200);
    });
    expect(post).toHaveBeenCalledWith({ type: "automa:probe", requestId: "r1", path: "/about" }, "*");

    // Another frame's message, another request's, or a malformed report are not the answer.
    await act(async () => {
      answer(window, { type: "automa:page-report", requestId: "r1", report });
      answer(frame.contentWindow, { type: "automa:page-report", requestId: "other", report });
      answer(frame.contentWindow, { type: "automa:page-report", requestId: "r1", report: { title: 5 } });
    });
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => answer(frame.contentWindow, { type: "automa:page-report", requestId: "r1", report }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(report);
  });

  it("looks again at a page that has not drawn anything yet", async () => {
    const onDone = vi.fn();
    const { frame, post } = await open(onDone);
    await act(async () => {
      frame.dispatchEvent(new Event("load"));
      vi.advanceTimersByTime(1200);
      answer(frame.contentWindow, { type: "automa:page-report", requestId: "r1", report: { ...report, outline: [] } });
    });
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(post).toHaveBeenCalledTimes(2);
    await act(async () => answer(frame.contentWindow, { type: "automa:page-report", requestId: "r1", report }));
    expect(onDone).toHaveBeenCalledWith(report);
  });

  it("gives up with nothing when the page never answers", async () => {
    const onDone = vi.fn();
    await open(onDone);
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(onDone).toHaveBeenCalledWith(null);
  });
});
