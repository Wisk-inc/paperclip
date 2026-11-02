import { deviceFilesApi } from "../api/deviceFiles";
import { isAutomaApp } from "./automa-native";
import { rememberSentPushToken, storeDeviceId, storedDeviceRegistrations } from "./device-identity";

/** An unreachable server must not hold up signing out. */
const RELEASE_TIMEOUT_MS = 4_000;

/**
 * Before the Automa app signs out of a server: stop that server's
 * notifications reaching this phone (they would keep putting the
 * organization's work on the lock screen of whoever holds it next), and
 * forget the registrations so the next person to sign in registers the phone
 * as theirs. Browsers have no push token and keep their registrations.
 */
export async function releaseThisPhoneBeforeSignOut(): Promise<void> {
  if (!isAutomaApp()) return;
  const registrations = storedDeviceRegistrations();
  if (registrations.length === 0) return;
  const cleared = Promise.allSettled(
    registrations.map(({ deviceId }) => deviceFilesApi.updateDevice(deviceId, { pushToken: null })),
  );
  await Promise.race([cleared, new Promise((resolve) => window.setTimeout(resolve, RELEASE_TIMEOUT_MS))]);
  for (const { companyId, deviceId } of registrations) {
    rememberSentPushToken(deviceId, null);
    storeDeviceId(companyId, null);
  }
}

const SIGNED_OUT_KEY = "automa.auth.signedOutOnPurpose";

/**
 * The person signed out on purpose: the sign-in page then waits for them
 * instead of signing them straight back in with the app's Google account.
 */
export function noteSignedOutOnPurpose() {
  try {
    window.localStorage.setItem(SIGNED_OUT_KEY, "1");
  } catch {
    // Storage refused; the app's Google sign-out still keeps them out.
  }
}

export function signedOutOnPurpose(): boolean {
  try {
    return window.localStorage.getItem(SIGNED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearSignedOutOnPurpose() {
  try {
    window.localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    // Nothing to clear.
  }
}
