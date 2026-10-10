/**
 * Bridge to the Automa Android app.
 *
 * When the board runs inside the Automa app, the native shell injects
 * `window.AutomaNative`. It gives the page what a browser tab cannot have:
 * a stable device identity, a folder the person chose to share (read through
 * the Android storage picker, never the whole disk), and files handed to the
 * app from the system share sheet. File bytes never cross the bridge as
 * strings: the app serves them on a same-origin URL that it intercepts
 * locally, so the page reads them with `fetch` and uploads them with the
 * ordinary API client.
 *
 * Android injects the bridge into every frame of the WebView, sandboxed
 * Studio previews included, so each call carries the page key the app hands
 * only to its own pages (`window.__automaKey`); the app refuses calls without
 * it.
 *
 * In a regular browser `window.AutomaNative` is absent and every helper here
 * returns `null`, so callers fall back to browser behavior.
 */

import type { DeviceSharedIndexEntry } from "@paperclipai/shared";

export interface AutomaNativeInfo {
  clientKey: string;
  deviceName: string;
  platform: "android";
  appVersion: string;
  sdkInt: number;
}

export interface AutomaSharedFolderListing {
  name: string;
  entries: DeviceSharedIndexEntry[];
  truncated: boolean;
}

export interface AutomaIncomingShare {
  id: string;
  name: string;
  byteSize: number | null;
  contentType: string | null;
  /** Same-origin URL the app serves the shared bytes on. */
  url: string;
}

/** The raw methods the Android shell exposes through `addJavascriptInterface`; `key` is the page key. */
interface AutomaNativeRaw {
  getInfo(key: string): string;
  getSharedFolder(key: string): string;
  pickSharedFolder(key: string, callId: string): void;
  clearSharedFolder(key: string): void;
  listSharedFolder(key: string, callId: string): void;
  sharedFileUrl(key: string, path: string): string;
  getIncomingShares(key: string): string;
  clearIncomingShares(key: string): void;
  setDarkTheme?(key: string, dark: boolean): void;
  /** Plays a system haptic (`tick`, `thud`, `success`, `warning`); honors the phone's touch-feedback setting. */
  haptic?(key: string, kind: string): void;
  /** `{ enabled, user }` for the app's Firebase "Continue with Google" account. */
  getAuthState?(key: string): string;
  /** Resolves `{ ok, idToken }` with a Firebase ID token, signing in with Google first when needed. */
  firebaseIdToken?(key: string, callId: string): void;
  /** This phone's Firebase Cloud Messaging token, or "" when push is not set up. */
  pushToken?(key: string): string;
  /** Signs the app's Google account out on this phone. */
  signOut?(key: string): void;
  /** Shows the connect screen (sign in again, or pick another server). */
  openConnectScreen?(key: string): void;
}

export interface AutomaAppAccount {
  uid: string;
  name: string | null;
  email: string | null;
  photoUrl: string | null;
}

declare global {
  interface Window {
    AutomaNative?: AutomaNativeRaw;
    /** The page key the app injects into its own pages before any script runs. */
    __automaKey?: string;
    __automaNative?: { resolve: (callId: string, payload: string) => void };
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const pending = new Map<string, Pending>();
let callCounter = 0;

function pageKey(): string {
  return typeof window !== "undefined" && typeof window.__automaKey === "string" ? window.__automaKey : "";
}

function ensureResolver() {
  if (typeof window === "undefined" || window.__automaNative) return;
  window.__automaNative = {
    resolve(callId, payload) {
      const entry = pending.get(callId);
      if (!entry) return;
      pending.delete(callId);
      try {
        const parsed = JSON.parse(payload) as { ok?: boolean; error?: string };
        if (parsed && parsed.ok === false) entry.reject(new Error(parsed.error ?? "The Automa app could not finish that"));
        else entry.resolve(parsed);
      } catch {
        entry.reject(new Error("The Automa app sent an unreadable reply"));
      }
    },
  };
}

function callAsync<T>(invoke: (raw: AutomaNativeRaw, key: string, callId: string) => void): Promise<T> {
  const raw = rawBridge();
  if (!raw) return Promise.reject(new Error("Not running inside the Automa app"));
  ensureResolver();
  callCounter += 1;
  const callId = `call-${Date.now()}-${callCounter}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(callId, { resolve: resolve as (value: unknown) => void, reject });
    try {
      invoke(raw, pageKey(), callId);
    } catch (error) {
      pending.delete(callId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function rawBridge(): AutomaNativeRaw | null {
  if (typeof window === "undefined") return null;
  const raw = window.AutomaNative;
  return raw && typeof raw.getInfo === "function" ? raw : null;
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function isAutomaApp(): boolean {
  return rawBridge() !== null;
}

export const automaNative = {
  info(): AutomaNativeInfo | null {
    const raw = rawBridge();
    return raw ? parseJson<AutomaNativeInfo>(raw.getInfo(pageKey())) : null;
  },
  sharedFolder(): { name: string } | null {
    const raw = rawBridge();
    return raw ? parseJson<{ name: string }>(raw.getSharedFolder(pageKey())) : null;
  },
  pickSharedFolder(): Promise<{ name: string }> {
    return callAsync((raw, key, callId) => raw.pickSharedFolder(key, callId));
  },
  clearSharedFolder() {
    rawBridge()?.clearSharedFolder(pageKey());
  },
  listSharedFolder(): Promise<AutomaSharedFolderListing> {
    return callAsync((raw, key, callId) => raw.listSharedFolder(key, callId));
  },
  /** Read one file from the shared folder as a Blob. */
  async readSharedFile(path: string): Promise<Blob> {
    const raw = rawBridge();
    if (!raw) throw new Error("Not running inside the Automa app");
    const url = raw.sharedFileUrl(pageKey(), path);
    if (!url) throw new Error("The Automa app refused the file");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 404 ? `${path} is no longer in the shared folder` : "Could not read the file");
    return res.blob();
  },
  incomingShares(): AutomaIncomingShare[] {
    const raw = rawBridge();
    return (raw ? parseJson<AutomaIncomingShare[]>(raw.getIncomingShares(pageKey())) : null) ?? [];
  },
  clearIncomingShares() {
    rawBridge()?.clearIncomingShares(pageKey());
  },
  setDarkTheme(dark: boolean) {
    rawBridge()?.setDarkTheme?.(pageKey(), dark);
  },
  /** The app's Google account (Firebase), when this build has Firebase set up. */
  account(): { enabled: boolean; user: AutomaAppAccount | null } | null {
    const raw = rawBridge();
    if (!raw?.getAuthState) return null;
    return parseJson<{ enabled: boolean; user: AutomaAppAccount | null }>(raw.getAuthState(pageKey()));
  },
  /** A Firebase ID token for the server's "Continue with Google" sign-in. */
  firebaseIdToken(): Promise<string> {
    return callAsync<{ idToken: string }>((raw, key, callId) => {
      if (!raw.firebaseIdToken) throw new Error("This version of the Automa app cannot sign in with Google");
      raw.firebaseIdToken(key, callId);
    }).then((reply) => reply.idToken);
  },
  /** This phone's push token, or null outside the app or before Firebase hands one out. */
  pushToken(): string | null {
    const token = rawBridge()?.pushToken?.(pageKey()) ?? "";
    return token.length > 0 ? token : null;
  },
  /** Signs the phone's Google account out of the app; the connect screen then asks to sign in again. */
  signOutOfGoogle(): boolean {
    const raw = rawBridge();
    if (!raw?.signOut) return false;
    raw.signOut(pageKey());
    return true;
  },
  /** Leaves this server for the app's connect screen. False outside the app. */
  openConnectScreen(): boolean {
    const raw = rawBridge();
    if (!raw?.openConnectScreen) return false;
    raw.openConnectScreen(pageKey());
    return true;
  },
  /** Returns false when the app build has no haptic bridge, so callers can fall back. */
  haptic(kind: string): boolean {
    const raw = rawBridge();
    if (!raw?.haptic) return false;
    raw.haptic(pageKey(), kind);
    return true;
  },
};
