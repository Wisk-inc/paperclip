import { useCallback, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanyDevice } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { deviceFilesApi } from "../api/deviceFiles";
import { queryKeys } from "../lib/queryKeys";
import { automaNative } from "../lib/automa-native";
import { storedDeviceId } from "../lib/device-identity";
import {
  THIS_DEVICE_CHANGED_EVENT,
  forgetThisDevice,
  registerThisDevice,
  syncPushToken,
  type ThisDeviceChange,
} from "../lib/this-device";

/**
 * The current phone or browser as a registered company device.
 *
 * Inside the Automa app the phone registers itself from every page
 * (DeviceFilesSync: installing the app is the consent); a browser asks the
 * person first. Removing this phone sticks: it registers again only when the
 * person taps "Connect this phone". The registration is idempotent per
 * install, so reinstalling or clearing storage finds the same device again.
 */
export function useThisDevice(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const [deviceId, setDeviceId] = useState<string | null>(() => (companyId ? storedDeviceId(companyId) : null));
  const [device, setDevice] = useState<CompanyDevice | null>(null);

  useEffect(() => {
    setDeviceId(companyId ? storedDeviceId(companyId) : null);
    setDevice(null);
  }, [companyId]);

  // The background sync may register (or lose) this device while the page is open.
  useEffect(() => {
    if (!companyId) return;
    const onChange = (event: Event) => {
      const change = (event as CustomEvent<ThisDeviceChange>).detail;
      if (!change || change.companyId !== companyId) return;
      setDeviceId(change.deviceId);
      if (!change.deviceId) setDevice(null);
    };
    window.addEventListener(THIS_DEVICE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(THIS_DEVICE_CHANGED_EVENT, onChange);
  }, [companyId]);

  /** "Connect this phone/browser": registers, and lifts an earlier removal. */
  const register = useMutation({
    mutationFn: async () => {
      if (!companyId) throw new Error("Pick an organization first");
      return registerThisDevice(companyId);
    },
    onSuccess: (registered) => {
      if (!companyId) return;
      setDeviceId(registered.id);
      setDevice(registered);
      void queryClient.invalidateQueries({ queryKey: queryKeys.deviceFiles.overview(companyId) });
    },
  });

  /** This device was removed: forget it here and stop sharing its folder with this organization. */
  const forget = useCallback(() => {
    if (!companyId) return;
    const folder = automaNative.sharedFolder();
    if (folder && (folder.companyId === companyId || !automaNative.sharedFolderKnowsOrganization())) {
      automaNative.clearSharedFolder();
    }
    forgetThisDevice(companyId, { onPurpose: true });
    setDeviceId(null);
    setDevice(null);
  }, [companyId]);

  // Confirm the stored registration still exists (it may have been removed
  // from another device) and keep last-seen fresh.
  useEffect(() => {
    if (!companyId || !deviceId) return;
    let cancelled = false;
    deviceFilesApi
      .heartbeat(deviceId)
      .then(async (result) => {
        if (cancelled) return;
        setDevice(result.device);
        const updated = await syncPushToken(deviceId).catch(() => null);
        if (updated && !cancelled) setDevice(updated);
      })
      .catch((error: unknown) => {
        if (cancelled || !(error instanceof ApiError)) return;
        // 409: removed by a person, so it stays removed. 404: unknown to this
        // server, so the app registers it afresh.
        if (error.status === 409) forget();
        else if (error.status === 404) {
          forgetThisDevice(companyId, { onPurpose: false });
          setDeviceId(null);
          setDevice(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, deviceId, forget]);

  return { deviceId, device, setDevice, register, forget };
}
