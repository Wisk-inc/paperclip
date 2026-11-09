/**
 * The first path segment after `/apps/` on every Apps page that is not a
 * connection: `/apps/byo` is the bring-your-own setup page, not the detail
 * page of a connection called "byo". Both layouts read a connection id from
 * `/apps/:connectionId`, so a segment missing here makes them mount the
 * connection sidebar for a connection that does not exist and ask the server
 * for it (a 404). Keep this in step with the static `apps/…` routes in
 * `App.tsx`; `apps-routes.test.ts` fails when one is missing.
 */
export const RESERVED_APP_SUBPATHS: ReadonlySet<string> = new Set([
  "browse",
  "connections",
  "connect",
  "chat",
  "vercel-connect",
  "byo",
  "review",
  "attention",
  "gateways",
  "advanced",
  "app",
]);

/** The connection id an Apps path names, or null on an Apps page that is not a connection's. */
export function appConnectionIdFromSegments(segments: readonly string[]): string | null {
  if (segments[0]?.toLowerCase() !== "apps") return null;
  const candidate = segments[1];
  if (!candidate || RESERVED_APP_SUBPATHS.has(candidate.toLowerCase())) return null;
  return candidate;
}
