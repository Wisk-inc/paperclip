import { useCallback, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanyDevice } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { deviceFilesApi } from "../api/deviceFiles";
import { queryKeys } from "../lib/queryKeys";
import { automaNative, isAutomaApp } from "../lib/automa-native";
import {
  localDeviceIdentity,
  rememberSentPushToken,
  sentPushToken,
  storeDeviceId,
  storedDeviceId,
} from "../lib/device-identity";

/**
 * The current phone or browser as a registered company device.
 *
 * Inside the Automa app the device registers itself the first time the
 * company is opened (installing the app is the consent); a browser asks the
 * person first. The registration is idempotent per install, so reinstalling
 * or clearing storage finds the same device again.
 */
export function useThisDevice(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const [deviceId, setDeviceId] = useState<string | null>(() => (companyId ? storedDeviceId(companyId) : null));
  const [device, setDevice] = useState<CompanyDevice | null>(null);

  useEffect(() => {
    setDeviceId(companyId ? storedDeviceId(companyId) : null);
    setDevice(null);
  }, [companyId]);

  const register = useMutation({
    mutationFn: async () => {
      if (!companyId) throw new Error("Pick an organization first");
      const identity = localDeviceIdentity();
      return deviceFilesApi.registerDevice(companyId, identity);
    },
    onSuccess: (registered) => {
      if (!companyId) return;
      rememberSentPushToken(registered.id, automaNative.pushToken());
      storeDeviceId(companyId, registered.id);
      setDeviceId(registered.id);
      setDevice(registered);
      void queryClient.invalidateQueries({ queryKey: queryKeys.deviceFiles.overview(companyId) });
    },
  });

  const forget = useCallback(() => {
    if (!companyId) return;
    storeDeviceId(companyId, null);
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
        // Firebase rotates push tokens now and then; send the new one.
        const token = automaNative.pushToken();
        if (token && token !== sentPushToken(deviceId)) {
          const updated = await deviceFilesApi.updateDevice(deviceId, { pushToken: token });
          rememberSentPushToken(deviceId, token);
          if (!cancelled) setDevice(updated);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 409)) forget();
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, deviceId, forget]);

  // The app registers itself; browsers wait for an explicit tap.
  useEffect(() => {
    if (!companyId || deviceId || register.isPending || register.isError) return;
    if (isAutomaApp()) register.mutate();
  }, [companyId, deviceId, register]);

  return { deviceId, device, setDevice, register, forget };
}
