/**
 * Verifies Firebase Auth ID tokens (the token the Automa Android app gets
 * after "Continue with Google") without a service account or SDK: the token
 * is an RS256 JWT signed by Google's securetoken keys, and the checks follow
 * https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
 */
import crypto from "node:crypto";

export const FIREBASE_SECURETOKEN_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

/** Clock skew tolerated between this server and Google, in seconds. */
const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_CERT_TTL_MS = 60 * 60 * 1000;

export type FirebaseIdTokenClaims = {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  signInProvider: string | null;
};

export class FirebaseIdTokenError extends Error {
  constructor(readonly reason: string) {
    super(`Firebase ID token rejected: ${reason}`);
    this.name = "FirebaseIdTokenError";
  }
}

/** Returns the current `kid → X.509 PEM` map. */
export type FirebaseCertSource = () => Promise<Record<string, string>>;

/** Fetches Google's signing certificates and caches them for their advertised max-age. */
export function createFirebaseCertSource(
  fetchImpl: typeof fetch = fetch,
  nowMs: () => number = Date.now,
): FirebaseCertSource {
  let cache: { certs: Record<string, string>; expiresAt: number } | null = null;
  return async () => {
    if (cache && cache.expiresAt > nowMs()) return cache.certs;
    const res = await fetchImpl(FIREBASE_SECURETOKEN_CERTS_URL);
    if (!res.ok) throw new FirebaseIdTokenError("certs_unavailable");
    const certs = (await res.json()) as Record<string, string>;
    const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
    cache = { certs, expiresAt: nowMs() + (maxAge ? Number(maxAge) * 1000 : DEFAULT_CERT_TTL_MS) };
    return certs;
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (value && typeof value === "object") return value as Record<string, unknown>;
  } catch {
    // Fall through to the typed error below.
  }
  throw new FirebaseIdTokenError("malformed");
}

export async function verifyFirebaseIdToken(
  token: string,
  options: { projectId: string; certs: FirebaseCertSource; nowSeconds?: () => number },
): Promise<FirebaseIdTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new FirebaseIdTokenError("malformed");
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  const header = decodeSegment(rawHeader);
  const payload = decodeSegment(rawPayload);

  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new FirebaseIdTokenError("unsupported_header");
  const pem = (await options.certs())[header.kid];
  if (!pem) throw new FirebaseIdTokenError("unknown_key");

  const signatureOk = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${rawHeader}.${rawPayload}`),
    crypto.createPublicKey(pem),
    Buffer.from(rawSignature, "base64url"),
  );
  if (!signatureOk) throw new FirebaseIdTokenError("bad_signature");

  const now = (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  if (payload.aud !== options.projectId) throw new FirebaseIdTokenError("wrong_audience");
  if (payload.iss !== `https://securetoken.google.com/${options.projectId}`) throw new FirebaseIdTokenError("wrong_issuer");
  if (typeof payload.exp !== "number" || payload.exp <= now - CLOCK_SKEW_SECONDS) throw new FirebaseIdTokenError("expired");
  if (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_SECONDS) throw new FirebaseIdTokenError("issued_in_future");
  if (typeof payload.auth_time === "number" && payload.auth_time > now + CLOCK_SKEW_SECONDS) {
    throw new FirebaseIdTokenError("auth_in_future");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 128) {
    throw new FirebaseIdTokenError("no_subject");
  }

  const firebase = payload.firebase && typeof payload.firebase === "object" ? (payload.firebase as Record<string, unknown>) : {};
  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
    signInProvider: typeof firebase.sign_in_provider === "string" ? firebase.sign_in_provider : null,
  };
}
