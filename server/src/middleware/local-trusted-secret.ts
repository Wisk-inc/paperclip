import { timingSafeEqual } from "node:crypto";

/**
 * The local trusted secret: a lock on `local_trusted` instances that share
 * their loopback with other principals.
 *
 * `local_trusted` treats every request as the one operator at the keyboard,
 * which holds on a laptop where loopback is private. On an Android phone
 * (Automa in Termux) every installed app can reach 127.0.0.1, so there the
 * launcher sets `PAPERCLIP_LOCAL_TRUSTED_SECRET` and hands the value to the
 * Automa app, which sends it on every request as a cookie. Without it a
 * request is anonymous: it can still reach public routes and authenticate
 * with an agent key, but it is never the board.
 */
export const LOCAL_TRUSTED_SECRET_ENV = "PAPERCLIP_LOCAL_TRUSTED_SECRET";
export const LOCAL_TRUSTED_SECRET_COOKIE = "paperclip_local_secret";
/** Shorter values are refused at boot: the lock must not be guessable. */
export const LOCAL_TRUSTED_SECRET_MIN_LENGTH = 16;

type HeaderValue = string | string[] | undefined;

export function readLocalTrustedSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[LOCAL_TRUSTED_SECRET_ENV];
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.length < LOCAL_TRUSTED_SECRET_MIN_LENGTH) {
    throw new Error(`${LOCAL_TRUSTED_SECRET_ENV} must be at least ${LOCAL_TRUSTED_SECRET_MIN_LENGTH} characters`);
  }
  return value;
}

export function secretsMatch(presented: string | null | undefined, secret: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function first(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The value of one cookie in a Cookie header, or null. */
export function cookieValue(cookieHeader: HeaderValue, name: string): string | null {
  const header = first(cookieHeader);
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function bearerToken(authorization: HeaderValue): string | null {
  const header = first(authorization);
  if (!header || !/^bearer\s/i.test(header)) return null;
  const token = header.slice("bearer".length).trim();
  return token.length > 0 ? token : null;
}

/** Whether the request carries the secret as a bearer token (CLI, scripts). */
export function presentsLocalTrustedSecretAsBearer(headers: { authorization?: HeaderValue }, secret: string): boolean {
  return secretsMatch(bearerToken(headers.authorization), secret);
}

/** Whether the request carries the secret at all: as the cookie (the app) or as a bearer token. */
export function presentsLocalTrustedSecret(headers: { cookie?: HeaderValue; authorization?: HeaderValue }, secret: string): boolean {
  return secretsMatch(cookieValue(headers.cookie, LOCAL_TRUSTED_SECRET_COOKIE), secret) || presentsLocalTrustedSecretAsBearer(headers, secret);
}

/**
 * Whether a browser `Origin` header belongs to the host a request arrived
 * at. Absent means a non-browser client (allowed); `null` (a sandboxed
 * frame) or another site is refused. Scheme is not compared: behind a TLS
 * proxy the page is https while the hop to Automa is http.
 */
export function originMatchesHost(origin: HeaderValue, host: HeaderValue): boolean {
  const originValue = first(origin);
  if (originValue === undefined) return true;
  const hostValue = first(host)?.trim().toLowerCase();
  if (!hostValue) return false;
  let url: URL;
  try {
    url = new URL(originValue);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const originHost = url.hostname.toLowerCase();
  const originPort = url.port || defaultPort;
  const [hostName, hostPort] = splitHost(hostValue);
  return originHost === hostName && originPort === (hostPort ?? defaultPort);
}

function splitHost(host: string): [string, string | null] {
  const bracket = host.lastIndexOf("]");
  const colon = host.lastIndexOf(":");
  if (colon > bracket) return [host.slice(0, colon), host.slice(colon + 1)];
  return [host, null];
}
