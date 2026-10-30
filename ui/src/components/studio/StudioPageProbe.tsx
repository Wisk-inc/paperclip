import { useEffect, useRef } from "react";
import { STUDIO_PROBE_VIEWPORTS, studioPageReportSchema, type StudioPageReport, type StudioProbeViewport } from "@paperclipai/shared";

/** An agent's view_app request, as the Studio socket hands it over. */
export interface StudioProbeRequest {
  requestId: string;
  viewport: StudioProbeViewport;
  path: string;
}

/** The first look waits for the page's scripts; a page with nothing on it yet gets a second look. */
const FIRST_LOOK_MS = 1200;
const SECOND_LOOK_MS = 1600;
/** The agent waits 20 seconds in all; this leaves time to send the report. */
const GIVE_UP_MS = 9000;

/**
 * An agent asked to see the page (view_app): it opens here out of sight, at
 * the phone or desktop size the agent asked for, in the preview's sandbox,
 * and the probe script Automa puts in every previewed page reports what is
 * on the screen. Null goes back when the page never answered.
 */
export function StudioPageProbe({
  previewPath,
  request,
  onDone,
}: {
  previewPath: string;
  request: StudioProbeRequest;
  onDone: (report: StudioPageReport | null) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const lookSoonRef = useRef<() => void>(() => undefined);
  const size = STUDIO_PROBE_VIEWPORTS[request.viewport];
  const src = `${previewPath}${request.path.replace(/^\/+/, "")}`;

  useEffect(() => {
    let finished = false;
    let looks = 0;
    let latest: StudioPageReport | null = null;
    const timers: number[] = [];
    const finish = (report: StudioPageReport | null) => {
      if (finished) return;
      finished = true;
      for (const timer of timers) window.clearTimeout(timer);
      doneRef.current(report);
    };
    const look = () => {
      if (finished) return;
      looks += 1;
      frameRef.current?.contentWindow?.postMessage({ type: "automa:probe", requestId: request.requestId, path: request.path }, "*");
    };
    lookSoonRef.current = () => {
      timers.push(window.setTimeout(look, FIRST_LOOK_MS));
    };
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { type?: unknown; requestId?: unknown; report?: unknown } | null;
      if (!data || data.type !== "automa:page-report" || data.requestId !== request.requestId) return;
      // The page wrote this report: only its well-formed, size-limited shape goes on.
      const parsed = studioPageReportSchema.safeParse(data.report);
      if (!parsed.success) return;
      latest = parsed.data;
      if (!latest.outline.length && looks < 2) {
        timers.push(window.setTimeout(look, SECOND_LOOK_MS));
        return;
      }
      finish(latest);
    };
    window.addEventListener("message", onMessage);
    timers.push(window.setTimeout(() => finish(latest), GIVE_UP_MS));
    return () => {
      finished = true;
      for (const timer of timers) window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      lookSoonRef.current = () => undefined;
    };
  }, [request.requestId, request.path]);

  return (
    <iframe
      ref={frameRef}
      src={src}
      title="Page check for the AI"
      aria-hidden="true"
      tabIndex={-1}
      // Same sandbox as the preview, without dialogs or popups: nobody sees this copy.
      sandbox="allow-scripts allow-forms"
      onLoad={() => lookSoonRef.current()}
      className="pointer-events-none fixed left-0 top-0 -z-10 border-0 opacity-0"
      style={{ width: size.width, height: size.height }}
      data-testid="studio-page-probe"
    />
  );
}
