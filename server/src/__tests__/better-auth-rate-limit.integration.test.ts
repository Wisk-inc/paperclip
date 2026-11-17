/**
 * The sign-in rate limit has to count each caller by an address the caller
 * cannot choose, driven through the real Better Auth mount and a migrated
 * Postgres.
 *
 * Better Auth's own default reads the address from X-Forwarded-For, which any
 * caller can set: a made-up address for every password guess gets a fresh
 * limit each time, so guessing never slows down. Paperclip hands Better Auth
 * the address Express derived under the operator's TRUST_PROXY policy instead
 * (no proxy is trusted unless the operator names one).
 *
 * The limit is three sign-in attempts per ten seconds per address. Better
 * Auth's in-memory counter lives for the whole process, so each test starts a
 * minute after the last one on a frozen clock.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authSessions, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { AUTH_CLIENT_IP_HEADER, createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import { applyTrustProxy, parseTrustProxyEnv } from "../middleware/trust-proxy.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
  } as unknown as Config;
}

describeEmbeddedPostgres("Better Auth sign-in rate limit", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let auth!: ReturnType<typeof createBetterAuthInstance>;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-rate-limit-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "true";
    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-rate-limit-");
    db = createDb(database.connectionString);
    auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    vi.useFakeTimers({ toFake: ["Date"] });
  }, 30_000);

  beforeEach(() => {
    vi.setSystemTime(new Date(Date.now() + 60_000));
  });

  afterAll(async () => {
    vi.useRealTimers();
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  /** Mounted exactly as `createApp` mounts it, after the same trust-proxy setup. */
  function mount(trustProxy?: string): express.Express {
    const app = express();
    applyTrustProxy(app, parseTrustProxyEnv(trustProxy));
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    return app;
  }

  async function wrongPassword(app: express.Express, headers: Record<string, string>): Promise<number> {
    const response = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .set(headers)
      .send({ email: "nobody@example.com", password: "not-the-password-1" });
    return response.status;
  }

  it("counts a caller who makes up a new X-Forwarded-For for each guess as one caller", async () => {
    const app = mount();
    const statuses: number[] = [];
    for (let guess = 1; guess <= 5; guess += 1) {
      statuses.push(await wrongPassword(app, { "x-forwarded-for": `203.0.113.${guess}` }));
    }
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it("ignores the client-address header when the caller sends it", async () => {
    const app = mount();
    const statuses: number[] = [];
    for (let guess = 1; guess <= 4; guess += 1) {
      statuses.push(await wrongPassword(app, { [AUTH_CLIENT_IP_HEADER]: `198.51.100.${guess}` }));
    }
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses[3]).toBe(429);
  });

  it("behind a proxy the operator trusts, counts each client the proxy names on its own", async () => {
    // Requests arrive from 127.0.0.1, the proxy TRUST_PROXY=loopback names.
    const app = mount("loopback");
    const first: number[] = [];
    for (let guess = 1; guess <= 4; guess += 1) {
      first.push(await wrongPassword(app, { "x-forwarded-for": "198.51.100.7" }));
    }
    expect(first.slice(0, 3)).not.toContain(429);
    expect(first[3]).toBe(429);
    // Another client behind the same proxy still has its own three tries.
    expect(await wrongPassword(app, { "x-forwarded-for": "198.51.100.8" })).not.toBe(429);
    // A client cannot borrow another one's limit by adding addresses in front:
    // the proxy appends the real one, and that is the one counted.
    expect(await wrongPassword(app, { "x-forwarded-for": "192.0.2.50, 198.51.100.7" })).toBe(429);
  });

  it("records the address Express saw on a new session, not one the caller made up", async () => {
    const app = mount();
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .set("x-forwarded-for", "203.0.113.99")
      .send({ email: "rate-limit-founder@example.com", password: "correct-horse-battery-staple", name: "Founder" });
    expect(signUp.status).toBe(200);
    const sessions = await db.select({ ipAddress: authSessions.ipAddress }).from(authSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.ipAddress).not.toBe("203.0.113.99");
    expect(["127.0.0.1", "::1", "0000:0000:0000:0000:0000:0000:0000:0000"]).toContain(sessions[0]?.ipAddress);
  });
});
