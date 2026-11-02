import type { CompanyDevice } from "@paperclipai/shared";
import { deviceFilesApi } from "../api/deviceFiles";
import { automaNative } from "./automa-native";
import {
  localDeviceIdentity,
  markDeviceRemovedOnPurpose,
  rememberSentPushToken,
  sentPushToken,
  storeDeviceId,
} from "./device-identity";

/** Fired when this install's registration in an organization changes (registered, removed, forgotten). */
export const THIS_DEVICE_CHANGED_EVENT = "automa:this-device-changed";

export type ThisDeviceChange = { companyId: string; deviceId: string | null };

function announce(change: ThisDeviceChange) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ThisDeviceChange>(THIS_DEVICE_CHANGED_EVENT, { detail: change }));
}

/**
 * Registers this install in `companyId` (or finds its existing registration)
 * and remembers the push token that went with it: the one actually sent, so a
 * token that rotates during the request is sent again next time.
 */
export async function registerThisDevice(companyId: string): Promise<CompanyDevice> {
  const identity = localDeviceIdentity();
  const registered = await deviceFilesApi.registerDevice(companyId, identity);
  rememberSentPushToken(registered.id, identity.pushToken ?? null);
  storeDeviceId(companyId, registered.id);
  markDeviceRemovedOnPurpose(companyId, false);
  announce({ companyId, deviceId: registered.id });
  return registered;
}

/**
 * Forgets this install's registration in `companyId`. `onPurpose` (the person
 * removed it, here or from another device) also stops the app registering
 * itself there again until they tap "Connect this phone".
 */
export function forgetThisDevice(companyId: string, options: { onPurpose: boolean }) {
  storeDeviceId(companyId, null);
  if (options.onPurpose) markDeviceRemovedOnPurpose(companyId, true);
  announce({ companyId, deviceId: null });
}

/** Firebase rotates push tokens now and then: sends the new one, and only then remembers it. */
export async function syncPushToken(deviceId: string): Promise<CompanyDevice | null> {
  const token = automaNative.pushToken();
  if (!token || token === sentPushToken(deviceId)) return null;
  const updated = await deviceFilesApi.updateDevice(deviceId, { pushToken: token });
  rememberSentPushToken(deviceId, token);
  return updated;
}

/**
 * The phone's shared folder as `companyId` sees it: its own, or none. A folder
 * belongs to the organization it was shared in; another organization neither
 * lists it nor auto-sends from it. One shared before 1.9.6 carries no
 * organization and goes to the one whose server record already lists it.
 * An app older than 1.9.6 keeps one folder for the whole app, as before.
 */
export function sharedFolderFor(
  companyId: string,
  serverFolderName: string | null | undefined,
): { name: string } | null {
  const folder = automaNative.sharedFolder();
  if (!folder) return null;
  if (!automaNative.sharedFolderKnowsOrganization()) return folder;
  if (folder.companyId === companyId) return folder;
  if (!folder.companyId && serverFolderName && serverFolderName === folder.name) {
    const claimed = automaNative.claimSharedFolder(companyId);
    return claimed?.companyId === companyId ? claimed : null;
  }
  return null;
}
