/**
 * How queries treat the browser's offline signal. A server on this device
 * (Automa on a phone runs at 127.0.0.1) answers without the internet, so
 * requests to it must not pause when the phone loses its connection; a
 * remote server keeps the default, which waits for the connection to return.
 */
export function queryNetworkMode(hostname: string): "always" | "online" {
  return isLoopbackHostname(hostname) ? "always" : "online";
}

/** A server on this very device (127.0.0.1, localhost, ::1). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** This board is served by a server on this very device. */
export function onLoopbackServer(): boolean {
  return typeof window !== "undefined" && isLoopbackHostname(window.location.hostname);
}
