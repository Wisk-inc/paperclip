import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { applyBaseSecurityHeaders, setBoardDocumentHeaders } from "../middleware/security-headers.js";

/** Mounted the way createApp mounts it: base headers first, the board page sets its own. */
function boardApp() {
  const app = express();
  applyBaseSecurityHeaders(app);
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/api/echo", (req, res) => {
    res.type("text/plain").send(String(req.query.text ?? ""));
  });
  app.get("/", (_req, res) => {
    setBoardDocumentHeaders(res);
    res.type("html").send("<!doctype html><title>Board</title>");
  });
  app.get("/_plugins/example/ui/index.html", (_req, res) => {
    res.type("html").send("<!doctype html><title>Plugin</title>");
  });
  app.get("/assets/app.js", (_req, res) => {
    res.type("js").send("export {};");
  });
  return app;
}

describe("security headers", () => {
  it("never announces Express, on any route or a missing one", async () => {
    const app = boardApp();
    for (const path of ["/", "/api/health", "/assets/app.js", "/_plugins/example/ui/index.html", "/no-such-page"]) {
      const response = await request(app).get(path);
      expect(response.headers["x-powered-by"], path).toBeUndefined();
    }
  });

  it("marks every API answer nosniff, including text that echoes a caller", async () => {
    const app = boardApp();
    for (const path of ["/api/health", "/api/echo?text=%3Cscript%3E", "/api/no-such-route"]) {
      expect((await request(app).get(path)).headers["x-content-type-options"], path).toBe("nosniff");
    }
  });

  it("lets only the board itself frame the board's page", async () => {
    const response = await request(boardApp()).get("/");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("leaves the pages the board frames, and its scripts, to their own rules", async () => {
    const app = boardApp();
    for (const path of ["/_plugins/example/ui/index.html", "/assets/app.js", "/api/health"]) {
      const response = await request(app).get(path);
      expect(response.headers["x-frame-options"], path).toBeUndefined();
      expect(response.headers["content-security-policy"], path).toBeUndefined();
    }
  });
});
