import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createFirebaseCertSource,
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
} from "../auth/firebase-id-token.js";
import { resolveFirebaseProjectId, resolveFirebaseUser } from "../auth/firebase-sign-in-plugin.js";

const PROJECT = "automa-agent";
const NOW = 1_800_000_000;
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const certs = async () => ({ "key-1": publicPem });

function sign(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "key-1", typ: "JWT" }, key = privateKey) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url");
  return `${unsigned}.${signature}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: "firebase-uid-1",
    iat: NOW - 10,
    exp: NOW + 3600,
    auth_time: NOW - 10,
    email: "Ada@Example.com",
    email_verified: true,
    name: "Ada Lovelace",
    picture: "https://example.com/ada.png",
    firebase: { sign_in_provider: "google.com" },
    ...overrides,
  };
}

const verify = (token: string) => verifyFirebaseIdToken(token, { projectId: PROJECT, certs, nowSeconds: () => NOW });

async function rejection(token: string) {
  try {
    await verify(token);
  } catch (error) {
    return error instanceof FirebaseIdTokenError ? error.reason : "other";
  }
  return "accepted";
}

describe("verifyFirebaseIdToken", () => {
  it("accepts a valid Google sign-in token and returns its identity", async () => {
    await expect(verify(sign(claims()))).resolves.toEqual({
      uid: "firebase-uid-1",
      email: "Ada@Example.com",
      emailVerified: true,
      name: "Ada Lovelace",
      picture: "https://example.com/ada.png",
      signInProvider: "google.com",
    });
  });

  it("rejects tokens for another project, issuer, or time window", async () => {
    expect(await rejection(sign(claims({ aud: "someone-else" })))).toBe("wrong_audience");
    expect(await rejection(sign(claims({ iss: "https://securetoken.google.com/someone-else" })))).toBe("wrong_issuer");
    expect(await rejection(sign(claims({ exp: NOW - 120 })))).toBe("expired");
    expect(await rejection(sign(claims({ iat: NOW + 600 })))).toBe("issued_in_future");
    expect(await rejection(sign(claims({ sub: "" })))).toBe("no_subject");
  });

  it("rejects bad signatures, unknown keys, other algorithms, and garbage", async () => {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(await rejection(sign(claims(), undefined, other))).toBe("bad_signature");
    expect(await rejection(sign(claims(), { alg: "RS256", kid: "key-2" }))).toBe("unknown_key");
    expect(await rejection(sign(claims(), { alg: "HS256", kid: "key-1" }))).toBe("unsupported_header");
    expect(await rejection("not.a.jwt")).toBe("malformed");
    expect(await rejection("only-one-part")).toBe("malformed");
  });

  it("caches Google's certificates for their advertised max-age", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ "key-1": publicPem }), { headers: { "cache-control": "public, max-age=100" } }),
    );
    const source = createFirebaseCertSource(fetchImpl as unknown as typeof fetch, () => now);
    await source();
    now = 99_000;
    await source();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 101_000;
    await source();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("resolveFirebaseUser", () => {
  const identity = {
    uid: "firebase-uid-1",
    email: "Ada@Example.com",
    emailVerified: true,
    name: "Ada Lovelace",
    picture: null,
    signInProvider: "google.com",
  };
  const user = { id: "user-1", email: "ada@example.com", name: "Ada" } as never;

  function adapter(existing: unknown) {
    return {
      findUserByEmail: vi.fn(async () => existing as never),
      createUser: vi.fn(async () => user),
      linkAccount: vi.fn(async () => ({})),
    };
  }

  it("signs in an existing user by verified email and links the Firebase identity once", async () => {
    const fresh = adapter({ user, accounts: [{ providerId: "credential", accountId: "user-1" }] });
    await expect(resolveFirebaseUser({ claims: identity, adapter: fresh, disableSignUp: true })).resolves.toMatchObject({ ok: true, created: false });
    expect(fresh.findUserByEmail).toHaveBeenCalledWith("ada@example.com", { includeAccounts: true });
    expect(fresh.createUser).not.toHaveBeenCalled();
    expect(fresh.linkAccount).toHaveBeenCalledWith({ userId: "user-1", providerId: "firebase", accountId: "firebase-uid-1" });

    const linked = adapter({ user, accounts: [{ providerId: "firebase", accountId: "firebase-uid-1" }] });
    await resolveFirebaseUser({ claims: identity, adapter: linked, disableSignUp: false });
    expect(linked.linkAccount).not.toHaveBeenCalled();
  });

  it("creates a new user on first sign-up when sign-up is allowed", async () => {
    const empty = adapter(null);
    await expect(resolveFirebaseUser({ claims: identity, adapter: empty, disableSignUp: false })).resolves.toMatchObject({ ok: true, created: true });
    expect(empty.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "ada@example.com", name: "Ada Lovelace", emailVerified: true }),
      expect.objectContaining({ method: "oauth" }),
    );
  });

  it("refuses new users when sign-up is off, and unverified emails always", async () => {
    await expect(resolveFirebaseUser({ claims: identity, adapter: adapter(null), disableSignUp: true })).resolves.toMatchObject({ ok: false });
    const unverified = adapter({ user, accounts: [] });
    await expect(resolveFirebaseUser({ claims: { ...identity, emailVerified: false }, adapter: unverified, disableSignUp: false })).resolves.toMatchObject({ ok: false });
    expect(unverified.findUserByEmail).not.toHaveBeenCalled();
  });
});

describe("resolveFirebaseProjectId", () => {
  it("reads a well-formed project id and ignores anything else", () => {
    expect(resolveFirebaseProjectId({ AUTOMA_FIREBASE_PROJECT_ID: " automa-agent " })).toBe("automa-agent");
    expect(resolveFirebaseProjectId({})).toBeNull();
    expect(resolveFirebaseProjectId({ AUTOMA_FIREBASE_PROJECT_ID: "Bad Project!" })).toBeNull();
  });
});
