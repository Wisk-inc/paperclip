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

/** The raw methods the Android shell exposes through `addJavascriptInterface`. */
interface AutomaNativeRaw {
  getInfo(): string;
  getSharedFolder(): string;
  pickSharedFolder(callId: string): void;
  clearSharedFolder(): void;
  listSharedFolder(callId: string): void;
  sharedFileUrl(path: string): string;
  getIncomingShares(): string;
  clearIncomingShares(): void;
  setDarkTheme?(dark: boolean): void;
  /** Plays a system haptic (`tick`, `thud`, `success`, `warning`); honors the phone's touch-feedback setting. */
  haptic?(kind: string): void;
  /** `{ enabled, user }` for the app's Firebase "Continue with Google" account. */
  getAuthState?(): string;
  /** Resolves `{ ok, idToken }` with a Firebase ID token, signing in with Google first when needed. */
  firebaseIdToken?(callId: string): void;
  /** This phone's Firebase Cloud Messaging token, or "" when push is not set up. */
  pushToken?(): string;
  /** Signs the app's Google account out on this phone. */
  signOut?(): void;
  /** Shows the connect screen (sign in again, or pick another server). */
  openConnectScreen?(): void;
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
    __automaNative?: { resolve: (callId: string, payload: string) => void };
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const pending = new Map<string, Pending>();
let callCounter = 0;

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

function callAsync<T>(invoke: (raw: AutomaNativeRaw, callId: string) => void): Promise<T> {
  const raw = rawBridge();
  if (!raw) return Promise.reject(new Error("Not running inside the Automa app"));
  ensureResolver();
  callCounter += 1;
  const callId = `call-${Date.now()}-${callCounter}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(callId, { resolve: resolve as (value: unknown) => void, reject });
    try {
      invoke(raw, callId);
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
    return raw ? parseJson<AutomaNativeInfo>(raw.getInfo()) : null;
  },
  sharedFolder(): { name: string } | null {
    const raw = rawBridge();
    return raw ? parseJson<{ name: string }>(raw.getSharedFolder()) : null;
  },
  pickSharedFolder(): Promise<{ name: string }> {
    return callAsync((raw, callId) => raw.pickSharedFolder(callId));
  },
  clearSharedFolder() {
    rawBridge()?.clearSharedFolder();
  },
  listSharedFolder(): Promise<AutomaSharedFolderListing> {
    return callAsync((raw, callId) => raw.listSharedFolder(callId));
  },
  /** Read one file from the shared folder as a Blob. */
  async readSharedFile(path: string): Promise<Blob> {
    const raw = rawBridge();
    if (!raw) throw new Error("Not running inside the Automa app");
    const url = raw.sharedFileUrl(path);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 404 ? `${path} is no longer in the shared folder` : "Could not read the file");
    return res.blob();
  },
  incomingShares(): AutomaIncomingShare[] {
    const raw = rawBridge();
    return (raw ? parseJson<AutomaIncomingShare[]>(raw.getIncomingShares()) : null) ?? [];
  },
  clearIncomingShares() {
    rawBridge()?.clearIncomingShares();
  },
  setDarkTheme(dark: boolean) {
    rawBridge()?.setDarkTheme?.(dark);
  },
  /** The app's Google account (Firebase), when this build has Firebase set up. */
  account(): { enabled: boolean; user: AutomaAppAccount | null } | null {
    const raw = rawBridge();
    if (!raw?.getAuthState) return null;
    return parseJson<{ enabled: boolean; user: AutomaAppAccount | null }>(raw.getAuthState());
  },
  /** A Firebase ID token for the server's "Continue with Google" sign-in. */
  firebaseIdToken(): Promise<string> {
    return callAsync<{ idToken: string }>((raw, callId) => {
      if (!raw.firebaseIdToken) throw new Error("This version of the Automa app cannot sign in with Google");
      raw.firebaseIdToken(callId);
    }).then((reply) => reply.idToken);
  },
  /** This phone's push token, or null outside the app or before Firebase hands one out. */
  pushToken(): string | null {
    const token = rawBridge()?.pushToken?.() ?? "";
    return token.length > 0 ? token : null;
  },
  /** Signs the phone's Google account out of the app; the connect screen then asks to sign in again. */
  signOutOfGoogle(): boolean {
    const raw = rawBridge();
    if (!raw?.signOut) return false;
    raw.signOut();
    return true;
  },
  /** Leaves this server for the app's connect screen. False outside the app. */
  openConnectScreen(): boolean {
    const raw = rawBridge();
    if (!raw?.openConnectScreen) return false;
    raw.openConnectScreen();
    return true;
  },
  /** Returns false when the app build has no haptic bridge, so callers can fall back. */
  haptic(kind: string): boolean {
    const raw = rawBridge();
    if (!raw?.haptic) return false;
    raw.haptic(kind);
    return true;
  },
};
