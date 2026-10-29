/**
 * How queries treat the browser's offline signal. A server on this device
 * (Automa on a phone runs at 127.0.0.1) answers without the internet, so
 * requests to it must not pause when the phone loses its connection; a
 * remote server keeps the default, which waits for the connection to return.
 */
export function queryNetworkMode(hostname: string): "always" | "online" {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host) ? "always" : "online";
}
