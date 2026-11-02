import { createHmac } from "node:crypto";

/**
 * Lets the Automa app check that the server on 127.0.0.1 is really this
 * Automa before it sends the app key there.
 *
 * The app key rides on every board request (a cookie the app sets), and any
 * program can listen on a loopback port. So the app first sends a random
 * challenge to /api/health, without the key, and only a server holding the
 * key can answer it: an HMAC of the challenge keyed by the app key. The
 * answer also covers the port this server listens on, so a program on the
 * app's port can't pass the challenge on to the real server on another port
 * and hand its answer back.
 *
 * The Android app computes the same value (ServerConfig.proofFor); the two
 * must stay in step.
 */
export const LOCAL_SECRET_PROOF_NONCE_HEADER = "x-automa-proof-nonce";
export const LOCAL_SECRET_PROOF_HEADER = "x-automa-proof";

/** 16 to 64 random bytes, as lowercase hex. */
const NONCE_PATTERN = /^[0-9a-f]{32,128}$/;

export function localSecretProof(secret: string, port: number, nonce: string): string {
  return createHmac("sha256", secret)
    .update(`automa-local-secret-proof:v1:${port}:${nonce}`)
    .digest("hex");
}

/**
 * The answer to a challenge header, or null when there is nothing to answer:
 * no key on this server, no listening port known, or no well-formed challenge.
 */
export function answerLocalSecretChallenge(
  secret: string | null | undefined,
  port: number | null | undefined,
  nonceHeader: string | null | undefined,
): string | null {
  if (!secret || !port || !nonceHeader) return null;
  const nonce = nonceHeader.trim().toLowerCase();
  if (!NONCE_PATTERN.test(nonce)) return null;
  return localSecretProof(secret, port, nonce);
}
