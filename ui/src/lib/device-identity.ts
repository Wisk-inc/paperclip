import type { DevicePlatform } from "@paperclipai/shared";
import { automaNative } from "./automa-native";

const CLIENT_KEY_STORAGE_KEY = "automa.device.clientKey";
const deviceIdStorageKey = (companyId: string) => `automa.device.${companyId}`;

export interface LocalDeviceIdentity {
  clientKey: string;
  name: string;
  platform: DevicePlatform;
  /** Present inside the Automa app once Firebase Cloud Messaging handed out a token. */
  pushToken?: string;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private windows can refuse storage; the device simply re-registers.
  }
}

function randomKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `web-${crypto.randomUUID()}`;
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** A readable default name such as "Chrome on Windows" or "Safari on iPhone". */
export function describeBrowser(userAgent: string): { name: string; platform: DevicePlatform } {
  const ua = userAgent.toLowerCase();
  const os = ua.includes("android")
    ? "Android"
    : ua.includes("iphone")
      ? "iPhone"
      : ua.includes("ipad")
        ? "iPad"
        : ua.includes("mac os")
          ? "Mac"
          : ua.includes("windows")
            ? "Windows"
            : ua.includes("linux")
              ? "Linux"
              : "this computer";
  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("firefox/")
      ? "Firefox"
      : ua.includes("chrome/")
        ? "Chrome"
        : ua.includes("safari/")
          ? "Safari"
          : "Browser";
  const platform: DevicePlatform =
    os === "Android" ? "android" : os === "iPhone" || os === "iPad" ? "ios" : "web";
  return { name: `${browser} on ${os}`, platform };
}

/** Who this install is, preferring the Automa app's own identity. */
export function localDeviceIdentity(): LocalDeviceIdentity {
  const native = automaNative.info();
  if (native) {
    const pushToken = automaNative.pushToken();
    return {
      clientKey: native.clientKey,
      name: native.deviceName,
      platform: "android",
      ...(pushToken ? { pushToken } : {}),
    };
  }
  let clientKey = readStorage(CLIENT_KEY_STORAGE_KEY);
  if (!clientKey) {
    clientKey = randomKey();
    writeStorage(CLIENT_KEY_STORAGE_KEY, clientKey);
  }
  const described = describeBrowser(typeof navigator === "undefined" ? "" : navigator.userAgent);
  return { clientKey, ...described };
}

const pushTokenStorageKey = (deviceId: string) => `automa.device.${deviceId}.pushToken`;

/** The push token last sent to the server for this device, to resend only when it rotates. */
export function sentPushToken(deviceId: string): string | null {
  return readStorage(pushTokenStorageKey(deviceId));
}

export function rememberSentPushToken(deviceId: string, token: string | null) {
  writeStorage(pushTokenStorageKey(deviceId), token);
}

export function storedDeviceId(companyId: string): string | null {
  return readStorage(deviceIdStorageKey(companyId));
}

export function storeDeviceId(companyId: string, deviceId: string | null) {
  writeStorage(deviceIdStorageKey(companyId), deviceId);
}

const removedStorageKey = (companyId: string) => `automa.device.${companyId}.removed`;

/**
 * Set when the person removed this phone from an organization (or someone
 * removed it from another device): the app then stops registering itself
 * there until they tap "Connect this phone" again.
 */
export function deviceRemovedOnPurpose(companyId: string): boolean {
  return readStorage(removedStorageKey(companyId)) === "1";
}

export function markDeviceRemovedOnPurpose(companyId: string, removed: boolean) {
  writeStorage(removedStorageKey(companyId), removed ? "1" : null);
}

const REGISTRATION_KEY = /^automa\.device\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Every organization this install is registered in on this server, from local storage. */
export function storedDeviceRegistrations(): Array<{ companyId: string; deviceId: string }> {
  const found: Array<{ companyId: string; deviceId: string }> = [];
  try {
    const storage = window.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const match = key ? REGISTRATION_KEY.exec(key) : null;
      const deviceId = key && match ? storage.getItem(key) : null;
      if (match && deviceId) found.push({ companyId: match[1]!, deviceId });
    }
  } catch {
    // Storage refused: nothing is remembered.
  }
  return found;
}
