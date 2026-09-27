import type { DevicePlatform } from "@paperclipai/shared";
import { automaNative } from "./automa-native";

const CLIENT_KEY_STORAGE_KEY = "automa.device.clientKey";
const deviceIdStorageKey = (companyId: string) => `automa.device.${companyId}`;

export interface LocalDeviceIdentity {
  clientKey: string;
  name: string;
  platform: DevicePlatform;
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
  if (native) return { clientKey: native.clientKey, name: native.deviceName, platform: "android" };
  let clientKey = readStorage(CLIENT_KEY_STORAGE_KEY);
  if (!clientKey) {
    clientKey = randomKey();
    writeStorage(CLIENT_KEY_STORAGE_KEY, clientKey);
  }
  const described = describeBrowser(typeof navigator === "undefined" ? "" : navigator.userAgent);
  return { clientKey, ...described };
}

export function storedDeviceId(companyId: string): string | null {
  return readStorage(deviceIdStorageKey(companyId));
}

export function storeDeviceId(companyId: string, deviceId: string | null) {
  writeStorage(deviceIdStorageKey(companyId), deviceId);
}
