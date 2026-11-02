import { createHmac, randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  LOCAL_SECRET_PROOF_HEADER,
  LOCAL_SECRET_PROOF_NONCE_HEADER,
  answerLocalSecretChallenge,
  localSecretProof,
} from "../auth/local-secret-proof.js";
import { healthRoutes } from "../routes/health.js";
import { assertListenPortKeepsAppKeySafe } from "../startup-refusals.js";

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: vi.fn(() => undefined),
  toDevServerHealthStatus: vi.fn(),
}));

const SECRET = "a".repeat(48);

function createApp(answer?: (nonce: string | undefined) => string | null) {
  const app = express();
  const db = { execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]) } as unknown as Db;
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      localSecretRequired: Boolean(answer),
      authReady: true,
      companyDeletionEnabled: true,
      answerLocalSecretChallenge: answer,
    }),
  );
  return app;
}

describe("local secret proof", () => {
  it("is the HMAC the Android app computes: key = app key, message names version, port and challenge", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const expected = createHmac("sha256", SECRET).update(`automa-local-secret-proof:v1:3100:${nonce}`).digest("hex");
    expect(localSecretProof(SECRET, 3100, nonce)).toBe(expected);
  });

  it("differs by port, so an answer from a server on another port is no proof for this one", () => {
    const nonce = randomBytes(32).toString("hex");
    expect(localSecretProof(SECRET, 3100, nonce)).not.toBe(localSecretProof(SECRET, 3101, nonce));
  });

  it("answers only a well-formed challenge on a server that has a key and a port", () => {
    const nonce = randomBytes(32).toString("hex");
    expect(answerLocalSecretChallenge(SECRET, 3100, nonce)).toBe(localSecretProof(SECRET, 3100, nonce));
    // Uppercase or padded hex is the same challenge.
    expect(answerLocalSecretChallenge(SECRET, 3100, ` ${nonce.toUpperCase()} `)).toBe(localSecretProof(SECRET, 3100, nonce));
    expect(answerLocalSecretChallenge(null, 3100, nonce)).toBeNull();
    expect(answerLocalSecretChallenge(SECRET, 0, nonce)).toBeNull();
    expect(answerLocalSecretChallenge(SECRET, 3100, undefined)).toBeNull();
    expect(answerLocalSecretChallenge(SECRET, 3100, "short")).toBeNull();
    expect(answerLocalSecretChallenge(SECRET, 3100, "zz".repeat(20))).toBeNull();
    expect(answerLocalSecretChallenge(SECRET, 3100, "ab".repeat(65))).toBeNull();
  });
});

describe("GET /health with a challenge", () => {
  it("answers the challenge in a header (not cached) when the server holds a key", async () => {
    const app = createApp((nonce) => answerLocalSecretChallenge(SECRET, 3100, nonce));
    const nonce = randomBytes(32).toString("hex");
    const res = await request(app).get("/health").set(LOCAL_SECRET_PROOF_NONCE_HEADER, nonce);
    expect(res.status).toBe(200);
    expect(res.headers[LOCAL_SECRET_PROOF_HEADER]).toBe(localSecretProof(SECRET, 3100, nonce));
    expect(res.headers["cache-control"]).toBe("no-store");
    // The key itself never appears.
    expect(JSON.stringify(res.headers) + JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("sends no proof header without a challenge, or on a server without a key", async () => {
    const locked = createApp((nonce) => answerLocalSecretChallenge(SECRET, 3100, nonce));
    expect((await request(locked).get("/health")).headers[LOCAL_SECRET_PROOF_HEADER]).toBeUndefined();
    const open = createApp(undefined);
    const nonce = randomBytes(32).toString("hex");
    expect((await request(open).get("/health").set(LOCAL_SECRET_PROOF_NONCE_HEADER, nonce)).headers[LOCAL_SECRET_PROOF_HEADER]).toBeUndefined();
  });
});

describe("assertListenPortKeepsAppKeySafe", () => {
  it("stops a locked server from moving off the port the app sends its key to", () => {
    expect(() =>
      assertListenPortKeepsAppKeySafe({ localTrustedSecret: SECRET, requestedPort: 3100, selectedPort: 3101 }),
    ).toThrow(/Port 3100 is already in use by another program, so Automa did not start/);
  });

  it("lets a server without a key move, and a locked one keep its port", () => {
    expect(() => assertListenPortKeepsAppKeySafe({ localTrustedSecret: null, requestedPort: 3100, selectedPort: 3101 })).not.toThrow();
    expect(() => assertListenPortKeepsAppKeySafe({ localTrustedSecret: SECRET, requestedPort: 3100, selectedPort: 3100 })).not.toThrow();
  });
});
