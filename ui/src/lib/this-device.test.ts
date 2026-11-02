// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deviceFilesApi = vi.hoisted(() => ({ registerDevice: vi.fn(), updateDevice: vi.fn() }));
vi.mock("../api/deviceFiles", () => ({ deviceFilesApi }));

import { deviceRemovedOnPurpose, sentPushToken, storedDeviceId } from "./device-identity";
import { THIS_DEVICE_CHANGED_EVENT, forgetThisDevice, registerThisDevice, sharedFolderFor, syncPushToken } from "./this-device";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function installApp(options: { token?: string; folder?: Record<string, unknown> | null; knowsOrganization?: boolean } = {}) {
  let token = options.token ?? "";
  let folder = options.folder ?? null;
  const bridge: Record<string, unknown> = {
    getInfo: () => JSON.stringify({ clientKey: "android-1", deviceName: "Pixel" }),
    pushToken: () => token,
    getSharedFolder: () => JSON.stringify(folder),
    claimSharedFolder: vi.fn((_key: string, companyId: string) => {
      if (folder && !folder.companyId) folder = { ...folder, companyId };
      return JSON.stringify(folder);
    }),
  };
  if (options.knowsOrganization !== false) bridge.pickSharedFolderFor = vi.fn();
  (window as unknown as { AutomaNative: unknown }).AutomaNative = bridge;
  window.__automaKey = "page-key";
  return { setToken: (next: string) => (token = next), bridge };
}

describe("this device", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    delete (window as unknown as { AutomaNative?: unknown }).AutomaNative;
    delete window.__automaKey;
    vi.clearAllMocks();
  });

  it("remembers the push token it actually sent, so one that rotates mid-request goes again", async () => {
    const app = installApp({ token: "token-1" });
    deviceFilesApi.registerDevice.mockImplementation(async () => {
      app.setToken("token-2"); // Firebase rotated while the request was out
      return { id: "device-1" };
    });
    const changes: unknown[] = [];
    window.addEventListener(THIS_DEVICE_CHANGED_EVENT, (event) => changes.push((event as CustomEvent).detail));
    await registerThisDevice(COMPANY);
    expect(sentPushToken("device-1")).toBe("token-1");
    expect(storedDeviceId(COMPANY)).toBe("device-1");
    expect(changes).toEqual([{ companyId: COMPANY, deviceId: "device-1" }]);

    deviceFilesApi.updateDevice.mockResolvedValue({ id: "device-1" });
    await syncPushToken("device-1");
    expect(deviceFilesApi.updateDevice).toHaveBeenCalledWith("device-1", { pushToken: "token-2" });
    expect(sentPushToken("device-1")).toBe("token-2");
    await syncPushToken("device-1");
    expect(deviceFilesApi.updateDevice).toHaveBeenCalledTimes(1);
  });

  it("keeps a removal until the person connects the phone again", async () => {
    installApp();
    localStorage.setItem(`automa.device.${COMPANY}`, "device-1");
    forgetThisDevice(COMPANY, { onPurpose: true });
    expect(storedDeviceId(COMPANY)).toBeNull();
    expect(deviceRemovedOnPurpose(COMPANY)).toBe(true);
    deviceFilesApi.registerDevice.mockResolvedValue({ id: "device-1" });
    await registerThisDevice(COMPANY);
    expect(deviceRemovedOnPurpose(COMPANY)).toBe(false);
  });

  it("shows the shared folder only in the organization it was shared with", () => {
    installApp({ folder: { name: "Photos", companyId: "other-company" } });
    expect(sharedFolderFor(COMPANY, "Photos")).toBeNull();
    installApp({ folder: { name: "Photos", companyId: COMPANY } });
    expect(sharedFolderFor(COMPANY, null)).toMatchObject({ name: "Photos" });
  });

  it("gives a folder shared before organizations were kept to the one already listing it", () => {
    const { bridge } = installApp({ folder: { name: "Photos", companyId: null } });
    // Another organization whose record lists something else gets nothing.
    expect(sharedFolderFor("company-b", "Contracts")).toBeNull();
    expect(bridge.claimSharedFolder).not.toHaveBeenCalled();
    expect(sharedFolderFor(COMPANY, "Photos")).toMatchObject({ name: "Photos", companyId: COMPANY });
    // Claimed: now it is that organization's alone.
    expect(sharedFolderFor("company-b", "Photos")).toBeNull();
  });

  it("keeps one folder for the whole app on an app too old to know organizations", () => {
    installApp({ folder: { name: "Photos" }, knowsOrganization: false });
    expect(sharedFolderFor(COMPANY, null)).toMatchObject({ name: "Photos" });
  });
});
