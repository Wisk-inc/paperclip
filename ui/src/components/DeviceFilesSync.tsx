import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CompanyDevice, DeviceFileRequest } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { deviceFilesApi } from "../api/deviceFiles";
import { automaNative, isAutomaApp } from "../lib/automa-native";
import { queryKeys } from "../lib/queryKeys";
import { deviceRemovedOnPurpose, storedDeviceId } from "../lib/device-identity";
import { forgetThisDevice, registerThisDevice, sharedFolderFor, syncPushToken } from "../lib/this-device";

const HEARTBEAT_MS = 20_000;
const INDEX_REFRESH_MS = 5 * 60_000;

function basename(path: string) {
  return path.split("/").pop() || path;
}

/**
 * Background work for the Automa app while it is open, on every page:
 * register this phone in the organization (installing the app is the
 * consent) and keep its push token current, so notifications reach it
 * without the Files page ever being opened; report the shared folder's
 * listing so agents can see what is there; and answer file requests for
 * files in that folder when the person switched auto-send on. Nothing leaves
 * the phone unless the person shared the folder in this organization AND
 * turned auto-send on; every other request waits for them on the Files page.
 *
 * Renders nothing, and does nothing in a regular browser.
 */
export function DeviceFilesSync({ companyId }: { companyId: string | null }) {
  const queryClient = useQueryClient();
  const busy = useRef(false);
  const lastIndexAt = useRef(0);
  const indexPaths = useRef<Set<string>>(new Set());
  const attempted = useRef<Set<string>>(new Set());
  const rememberedDevice = useRef<string | null>(null);

  useEffect(() => {
    if (!companyId || !isAutomaApp()) return;
    const company = companyId;
    let stopped = false;

    /** Lists the folder for agents; tells the server when there is none here any more. */
    async function syncIndex(deviceId: string, device: CompanyDevice) {
      const folder = sharedFolderFor(company, device.sharedFolderName);
      if (!folder) {
        indexPaths.current = new Set();
        // Shared elsewhere, revoked by Android, or stopped: the server must not
        // keep offering an old list (or auto-send) for it.
        if (device.sharedFolderName) {
          await deviceFilesApi.reportSharedIndex(deviceId, { sharedFolderName: null, entries: [] });
        }
        lastIndexAt.current = Date.now();
        return;
      }
      const listing = await automaNative.listSharedFolder();
      indexPaths.current = new Set(listing.entries.map((entry) => entry.path));
      await deviceFilesApi.reportSharedIndex(deviceId, { sharedFolderName: listing.name, entries: listing.entries });
      lastIndexAt.current = Date.now();
    }

    async function answer(deviceId: string, request: DeviceFileRequest) {
      if (!request.devicePath || !indexPaths.current.has(request.devicePath)) return false;
      if (attempted.current.has(request.id)) return false;
      attempted.current.add(request.id);
      const blob = await automaNative.readSharedFile(request.devicePath);
      await deviceFilesApi.fulfillRequest(request.id, {
        file: blob,
        filename: basename(request.devicePath),
        deviceId,
        devicePath: request.devicePath,
        note: "Sent automatically from the shared folder",
      });
      return true;
    }

    /** This phone's registration here, made on first need unless the person removed it. */
    async function ensureRegistered(): Promise<string | null> {
      const stored = storedDeviceId(company);
      if (stored) return stored;
      if (deviceRemovedOnPurpose(company)) return null;
      const registered = await registerThisDevice(company);
      void queryClient.invalidateQueries({ queryKey: queryKeys.deviceFiles.overview(company) });
      return registered.id;
    }

    async function tick() {
      if (busy.current || stopped || document.visibilityState === "hidden") return;
      busy.current = true;
      try {
        const deviceId = await ensureRegistered();
        if (!deviceId) return;
        // The app learns which server this registration is, to place its notifications.
        if (rememberedDevice.current !== deviceId) {
          automaNative.rememberPushDevice(deviceId);
          rememberedDevice.current = deviceId;
        }

        let beat: Awaited<ReturnType<typeof deviceFilesApi.heartbeat>>;
        try {
          beat = await deviceFilesApi.heartbeat(deviceId);
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            // Removed by a person (here or from another device): stay removed.
            forgetThisDevice(company, { onPurpose: true });
          } else if (error instanceof ApiError && error.status === 404) {
            // Unknown to this server (its data was reset): register afresh next time.
            forgetThisDevice(company, { onPurpose: false });
          }
          return;
        }

        // Each step on its own: one failing must not stop the others.
        try {
          await syncPushToken(deviceId);
        } catch {
          // Sent again on the next tick.
        }
        try {
          if (Date.now() - lastIndexAt.current > INDEX_REFRESH_MS) await syncIndex(deviceId, beat.device);
        } catch {
          // Unreadable folder or a refused listing: auto-send still works from the last list.
        }

        const { device, pendingRequests } = beat;
        let answered = 0;
        if (device.autoFulfill && device.sharedFolderName && indexPaths.current.size > 0) {
          for (const request of pendingRequests) {
            try {
              if (await answer(deviceId, request)) answered += 1;
            } catch {
              // Leave it pending for the person to answer by hand.
            }
          }
        }
        if (answered > 0 || pendingRequests.length > 0) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.deviceFiles.overview(company) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.deviceFiles.requests(company) });
          if (answered > 0) void queryClient.invalidateQueries({ queryKey: queryKeys.deviceFiles.files(company) });
        }
      } catch {
        // Offline or signed out; the next tick retries.
      } finally {
        busy.current = false;
      }
    }

    void tick();
    const timer = window.setInterval(() => void tick(), HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        lastIndexAt.current = 0;
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [companyId, queryClient]);

  return null;
}
