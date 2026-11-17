import type { Express, RequestHandler, Response } from "express";

/**
 * Security headers that do not depend on the route.
 *
 * - No `X-Powered-By: Express`: the server does not announce what it runs on.
 * - Every `/api` answer carries `X-Content-Type-Options: nosniff`, so a
 *   browser takes it as the type the server named (JSON stays JSON) instead
 *   of guessing, for example, HTML from text a caller put in an error message.
 */
export function applyBaseSecurityHeaders(app: Pick<Express, "disable" | "use">): void {
  app.disable("x-powered-by");
  app.use("/api", apiSecurityHeaders());
}

export function apiSecurityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  };
}

/**
 * Headers on the board's own page (index.html, served for every board route).
 * Only the board itself may show it in a frame, so another site cannot load
 * the board in a hidden frame and steer a click into it (clickjacking). That
 * matters most on a computer running in local-trusted mode without an app
 * key, where any page in the browser reaches the board as its operator. The
 * previews and plugin pages the board frames are other responses with their
 * own rules; they are not affected.
 */
export function setBoardDocumentHeaders(res: Pick<Response, "setHeader">): void {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
}
