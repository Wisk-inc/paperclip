import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import {
  LOCAL_TRUSTED_SECRET_COOKIE,
  cookieValue,
  originMatchesHost,
  presentsLocalTrustedSecret,
  readLocalTrustedSecret,
} from "../middleware/local-trusted-secret.js";

const SECRET = "phone-secret-0123456789abcdef";

function createApp(localTrustedSecret: string | null) {
  const app = express();
  app.use(actorMiddleware({ select: vi.fn() } as never, { deploymentMode: "local_trusted", localTrustedSecret }));
  app.use(boardMutationGuard());
  app.get("/actor", (req, res) => res.json(req.actor));
  app.post("/mutate", (req, res) => res.json(req.actor));
  return app;
}

describe("local trusted secret", () => {
  it("is read from the environment, and a short one is refused", () => {
    expect(readLocalTrustedSecret({})).toBeNull();
    expect(readLocalTrustedSecret({ PAPERCLIP_LOCAL_TRUSTED_SECRET: "  " })).toBeNull();
    expect(readLocalTrustedSecret({ PAPERCLIP_LOCAL_TRUSTED_SECRET: ` ${SECRET} ` })).toBe(SECRET);
    expect(() => readLocalTrustedSecret({ PAPERCLIP_LOCAL_TRUSTED_SECRET: "short" })).toThrow(/at least 16/);
  });

  it("reads the cookie and the bearer form", () => {
    expect(cookieValue(`a=1; ${LOCAL_TRUSTED_SECRET_COOKIE}=${encodeURIComponent(SECRET)}; b=2`, LOCAL_TRUSTED_SECRET_COOKIE)).toBe(SECRET);
    expect(cookieValue("a=1", LOCAL_TRUSTED_SECRET_COOKIE)).toBeNull();
    expect(presentsLocalTrustedSecret({ cookie: `${LOCAL_TRUSTED_SECRET_COOKIE}=${SECRET}` }, SECRET)).toBe(true);
    expect(presentsLocalTrustedSecret({ authorization: `Bearer ${SECRET}` }, SECRET)).toBe(true);
    expect(presentsLocalTrustedSecret({ cookie: `${LOCAL_TRUSTED_SECRET_COOKIE}=${SECRET}x` }, SECRET)).toBe(false);
    expect(presentsLocalTrustedSecret({}, SECRET)).toBe(false);
  });

  it("keeps every local request as the board when no secret is set", async () => {
    const res = await request(createApp(null)).get("/actor");
    expect(res.body).toMatchObject({ type: "board", source: "local_implicit" });
  });

  it("makes requests without the secret anonymous", async () => {
    const app = createApp(SECRET);
    expect((await request(app).get("/actor")).body).toMatchObject({ type: "none" });
    expect((await request(app).get("/actor").set("Cookie", `${LOCAL_TRUSTED_SECRET_COOKIE}=wrong-wrong-wrong-wrong`)).body).toMatchObject({ type: "none" });
  });

  it("trusts the cookie (the app) and the bearer form (the CLI)", async () => {
    const app = createApp(SECRET);
    const viaCookie = await request(app).get("/actor").set("Cookie", `${LOCAL_TRUSTED_SECRET_COOKIE}=${SECRET}`);
    expect(viaCookie.body).toMatchObject({ type: "board", source: "local_implicit" });
    const viaBearer = await request(app).get("/actor").set("Authorization", `Bearer ${SECRET}`).set("X-Paperclip-Run-Id", "run-1");
    expect(viaBearer.body).toMatchObject({ type: "board", source: "local_implicit", runId: "run-1" });
  });

  it("refuses browser mutations from other sites and sandboxed frames, keeps the CLI and own pages", async () => {
    const app = createApp(null);
    expect((await request(app).post("/mutate").send({})).status).toBe(200);
    expect((await request(app).post("/mutate").set("Origin", "http://127.0.0.1:3100").set("Host", "127.0.0.1:3100").send({})).status).toBe(200);
    expect((await request(app).post("/mutate").set("Origin", "null").send({})).status).toBe(403);
    expect((await request(app).post("/mutate").set("Origin", "https://evil.example").send({})).status).toBe(403);
  });

  it("matches a socket's Origin against the host it reached", () => {
    expect(originMatchesHost(undefined, "127.0.0.1:3100")).toBe(true);
    expect(originMatchesHost("http://127.0.0.1:3100", "127.0.0.1:3100")).toBe(true);
    expect(originMatchesHost("https://automa.example.com", "automa.example.com")).toBe(true);
    expect(originMatchesHost("https://automa.example.com", "automa.example.com:443")).toBe(true);
    expect(originMatchesHost("http://Automa.LAN:3100", "automa.lan:3100")).toBe(true);
    expect(originMatchesHost("null", "127.0.0.1:3100")).toBe(false);
    expect(originMatchesHost("http://127.0.0.1:3101", "127.0.0.1:3100")).toBe(false);
    expect(originMatchesHost("https://evil.example", "127.0.0.1:3100")).toBe(false);
    expect(originMatchesHost("http://[::1]:3100", "[::1]:3100")).toBe(true);
  });
});
