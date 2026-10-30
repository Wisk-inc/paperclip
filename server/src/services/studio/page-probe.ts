import { randomUUID } from "node:crypto";
import { STUDIO_PROBE_VIEWPORTS, type StudioPageReport, type StudioProbeViewport } from "@paperclipai/shared";
import { readableText } from "../../adapters/free-models/web.js";
import { studioHub } from "./hub.js";

/** How long an agent waits for the person's App Studio to render the page and report it. */
const PROBE_TIMEOUT_MS = process.env.VITEST ? 1_500 : 20_000;

interface Pending {
  workspaceId: string;
  resolve: (report: StudioPageReport | null) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/**
 * Asks the owner's open App Studio to render the page out of sight at a phone
 * or desktop size and report what is on it. Null when nobody has the project
 * open or no report came back in time.
 */
export function requestPageReport(
  workspaceId: string,
  options: { viewport: StudioProbeViewport; path: string },
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<StudioPageReport | null> {
  const requestId = randomUUID();
  const sent = studioHub.sendToOwners(workspaceId, { type: "preview:probe", requestId, viewport: options.viewport, path: options.path });
  if (!sent) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    pending.set(requestId, { workspaceId, resolve, timer });
  });
}

/** A report from the owner's App Studio; false when nothing was waiting for it (late, or another project's). */
export function deliverPageReport(workspaceId: string, requestId: string, report: StudioPageReport): boolean {
  const waiting = pending.get(requestId);
  if (!waiting || waiting.workspaceId !== workspaceId) return false;
  pending.delete(requestId);
  clearTimeout(waiting.timer);
  waiting.resolve(report);
  return true;
}

/** The report as the agent reads it. */
export function formatPageReport(report: StudioPageReport, viewport: StudioProbeViewport): string {
  const screen = `${report.viewport.width}×${report.viewport.height}`;
  const sideways = report.page.width > report.viewport.width + 1;
  const lines = [
    `How the page looks to the person on a ${viewport} screen (${screen}), rendered in their own browser with its scripts run:`,
    `Page: "${report.title || "(no title)"}" at ${report.path || "/"}`,
    `Size: ${report.page.width}×${report.page.height}${report.page.height > report.viewport.height ? " (scrolls down)" : " (fits without scrolling)"}${sideways ? "; WIDER THAN THE SCREEN, so people scroll sideways" : ""}`,
    "",
    "On the page, top to bottom (size, then position from the top left):",
    ...(report.outline.length ? report.outline.map((line) => `- ${line}`) : ["- (nothing visible: the page is blank)"]),
    "",
    report.problems.length ? "Problems:" : "Problems: none (no console errors, failed loads or uncaught errors).",
    ...report.problems.map((line) => `- ${line}`),
  ];
  if (report.warnings.length) lines.push("", "Layout and readability warnings:", ...report.warnings.map((line) => `- ${line}`));
  lines.push("", "Fix what is wrong, then look again with view_app to check.");
  return lines.join("\n");
}

/** One line on what the agent saw, for its step in the chat. */
export function pageReportSummary(report: StudioPageReport, viewport: StudioProbeViewport): string {
  const trouble = report.problems.length + report.warnings.length;
  return `Looked at ${report.path || "/"} on a ${viewport}${trouble ? `: ${trouble} thing${trouble === 1 ? "" : "s"} to fix` : ": looks right"}`;
}

/**
 * When nobody has App Studio open, the page's HTML is all there is: its text
 * and what it loads, without running its scripts.
 */
export async function staticPageOutline(port: number, path: string, viewport: StudioProbeViewport): Promise<string> {
  const target = `http://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(target, { signal: AbortSignal.timeout(8_000) });
  const html = await response.text();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const loads = [...html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/gi)].map((match) => match[1]!).slice(0, 30);
  const text = readableText(html).slice(0, 4_000);
  const { width, height } = STUDIO_PROBE_VIEWPORTS[viewport];
  return [
    `Nobody has this project open in App Studio right now, so the page could not be rendered on a ${viewport} screen (${width}×${height}). This is its HTML as served (HTTP ${response.status}), without running its scripts:`,
    `Page: "${title || "(no title)"}" at ${path || "/"}`,
    loads.length ? `It loads: ${loads.join(", ")}` : "It loads no scripts, styles or images.",
    "",
    "Text on the page:",
    text || "(no text without scripts: the page is drawn by JavaScript)",
    "",
    "To see it rendered, ask the person to open the project in App Studio, then use view_app again.",
  ].join("\n");
}
