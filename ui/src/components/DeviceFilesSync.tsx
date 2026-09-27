import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DeviceFileRequest } from "@paperclipai/shared";
import { deviceFilesApi } from "../api/deviceFiles";
import { automaNative, isAutomaApp } from "../lib/automa-native";
import { queryKeys } from "../lib/queryKeys";
import { storedDeviceId } from "../lib/device-identity";

const HEARTBEAT_MS = 20_000;
const INDEX_REFRESH_MS = 5 * 60_000;

function basename(path: string) {
  return path.split("/").pop() || path;
}

/**
 * Background work for the Automa app while it is open: report the shared
 * folder's listing so agents can see what is there, and answer file requests
 * for files in that folder when the person switched auto-send on. Nothing
 * leaves the phone unless the person shared the folder AND turned auto-send
 * on; every other request waits for them on the Files page.
 *
 * Renders nothing, and does nothing in a regular browser.
 */
export function DeviceFilesSync({ companyId }: { companyId: string | null }) {
  const queryClient = useQueryClient();
  const busy = useRef(false);
  const lastIndexAt = useRef(0);
  const indexPaths = useRef<Set<string>>(new Set());
  const attempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!companyId || !isAutomaApp()) return;
    let stopped = false;

    async function syncIndex(deviceId: string) {
      const folder = automaNative.sharedFolder();
      if (!folder) {
        indexPaths.current = new Set();
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

    async function tick() {
      if (busy.current || stopped || document.visibilityState === "hidden") return;
      const deviceId = storedDeviceId(companyId!);
      if (!deviceId) return;
      busy.current = true;
      try {
        if (Date.now() - lastIndexAt.current > INDEX_REFRESH_MS) await syncIndex(deviceId);
        const { device, pendingRequests } = await deviceFilesApi.heartbeat(deviceId);
        let answered = 0;
        if (device.autoFulfill && device.sharedFolderName) {
          for (const request of pendingRequests) {
            try {
              if (await answer(deviceId, request)) answered += 1;
            } catch {
              // Leave it pending for the person to answer by hand.
            }
          }
        }
        if (answered > 0 || pendingRequests.length > 0) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.deviceFiles.overview(companyId!) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.deviceFiles.requests(companyId!) });
          if (answered > 0) void queryClient.invalidateQueries({ queryKey: queryKeys.deviceFiles.files(companyId!) });
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
