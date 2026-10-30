import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { StudioPageReport } from "@paperclipai/shared";
import { studioHub } from "../services/studio/hub.js";
import { deliverPageReport, formatPageReport, pageReportSummary, requestPageReport, staticPageOutline } from "../services/studio/page-probe.js";
import { PREVIEW_PROBE_SCRIPT } from "../services/studio/page-probe-script.js";
import { injectIntoPreviewHtml, PREVIEW_STORAGE_SHIM } from "../routes/studio.js";

function fakeSocket() {
  const listeners = new Map<string, Array<(data?: unknown) => void>>();
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    sent,
    send: (data: string) => void sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => undefined,
    on: (event: string, listener: (data?: unknown) => void) => void listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    emit: (event: string, data?: unknown) => listeners.get(event)?.forEach((listener) => listener(data)),
    type: (event: object) => listeners.get("message")?.forEach((listener) => listener(JSON.stringify(event))),
  };
}

const report: StudioPageReport = {
  title: "To-do",
  path: "/",
  viewport: { width: 390, height: 844 },
  page: { width: 520, height: 1400 },
  outline: ['h1 "My to-dos" 358x38 at (16,24)', 'button "Add" 20x18 at (330,80)'],
  problems: ["console.error: todos is not defined"],
  warnings: ["Small to tap (20x18, aim for 44x44): button \"Add\""],
};

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

describe("view_app: the person's App Studio renders the page for the agent", () => {
  it("asks only the owner's open App Studio, and hands the report to the waiting agent", async () => {
    const workspaceId = "probe-workspace";
    const owner = fakeSocket();
    const guest = fakeSocket();
    studioHub.join({ workspaceId, socket: owner, participant: { id: "owner", name: "Owner", role: "owner", color: "#7048E8" } });
    studioHub.join({ workspaceId, socket: guest, participant: { id: "guest:1", name: "Sam", role: "guest", color: "#2F9E44" }, collaboratorId: "1" });
    closers.push(() => owner.emit("close"), () => guest.emit("close"));

    const waiting = requestPageReport(workspaceId, { viewport: "phone", path: "/" }, 5_000);
    const asked = owner.sent.find((event) => event.type === "preview:probe")!;
    expect(asked).toMatchObject({ type: "preview:probe", viewport: "phone", path: "/" });
    // Guests never get to render (or answer for) the owner's agent.
    expect(guest.sent.some((event) => event.type === "preview:probe")).toBe(false);
    // Another project's answer, or a made-up id, goes nowhere.
    expect(deliverPageReport("other-workspace", String(asked.requestId), report)).toBe(false);
    expect(deliverPageReport(workspaceId, "made-up", report)).toBe(false);
    expect(deliverPageReport(workspaceId, String(asked.requestId), report)).toBe(true);
    await expect(waiting).resolves.toEqual(report);
    // Answered once; a late repeat is ignored.
    expect(deliverPageReport(workspaceId, String(asked.requestId), report)).toBe(false);
  });

  it("gives up when nobody has the project open, or nobody answers in time", async () => {
    await expect(requestPageReport("nobody-here", { viewport: "desktop", path: "/" })).resolves.toBeNull();
    const workspaceId = "silent-workspace";
    const owner = fakeSocket();
    studioHub.join({ workspaceId, socket: owner, participant: { id: "owner", name: "Owner", role: "owner", color: "#7048E8" } });
    closers.push(() => owner.emit("close"));
    await expect(requestPageReport(workspaceId, { viewport: "phone", path: "/" }, 50)).resolves.toBeNull();
  });

  it("tells the agent what the person sees and what to fix", () => {
    const text = formatPageReport(report, "phone");
    expect(text).toContain("phone screen (390×844)");
    expect(text).toContain('Page: "To-do" at /');
    expect(text).toContain("WIDER THAN THE SCREEN");
    expect(text).toContain('- h1 "My to-dos" 358x38 at (16,24)');
    expect(text).toContain("- console.error: todos is not defined");
    expect(text).toContain("Small to tap");
    expect(text).toContain("look again with view_app");
    expect(pageReportSummary(report, "phone")).toBe("Looked at / on a phone: 2 things to fix");
    expect(pageReportSummary({ ...report, problems: [], warnings: [] }, "desktop")).toBe("Looked at / on a desktop: looks right");
    expect(formatPageReport({ ...report, outline: [] }, "phone")).toContain("nothing visible: the page is blank");
  });

  it("falls back to the page's HTML when App Studio is closed", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><html><head><title>Shop</title><link rel="stylesheet" href="/style.css"></head><body><h1>Fresh bread</h1><script src="/app.js"></script></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => server.close());
    const { port } = server.address() as AddressInfo;
    const text = await staticPageOutline(port, "/", "phone");
    expect(text).toContain("Nobody has this project open in App Studio");
    expect(text).toContain('Page: "Shop" at /');
    expect(text).toContain("It loads: /style.css, /app.js");
    expect(text).toContain("Fresh bread");
  });
});

describe("the probe in every previewed page", () => {
  it("goes in after the storage shim, before the page's own scripts", () => {
    const html = injectIntoPreviewHtml("<!doctype html><html><head><script src=\"app.js\"></script></head></html>", `${PREVIEW_STORAGE_SHIM}${PREVIEW_PROBE_SCRIPT}`);
    expect(html.indexOf(PREVIEW_PROBE_SCRIPT)).toBeGreaterThan(html.indexOf(PREVIEW_STORAGE_SHIM));
    expect(html.indexOf(PREVIEW_PROBE_SCRIPT)).toBeLessThan(html.indexOf('src="app.js"'));
  });

  it("answers only its parent frame, and leaves the preview link's token out of addresses", () => {
    expect(PREVIEW_PROBE_SCRIPT).toMatch(/^<script>\(function \(\) \{/);
    expect(PREVIEW_PROBE_SCRIPT).toContain("event.source !== window.parent");
    expect(PREVIEW_PROBE_SCRIPT).toContain('data.type !== "automa:probe"');
    expect(PREVIEW_PROBE_SCRIPT).toContain("\\/api\\/studio-preview\\/[^/]+\\/");
    // The page's own scripts can't close the tag early.
    expect(PREVIEW_PROBE_SCRIPT.slice(8, -9)).not.toContain("</script");
    // It is valid JavaScript.
    expect(() => new Function(PREVIEW_PROBE_SCRIPT.slice(8, -9))).not.toThrow();
  });
});
