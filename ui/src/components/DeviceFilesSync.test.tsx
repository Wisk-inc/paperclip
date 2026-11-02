// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { DeviceFilesSync } from "./DeviceFilesSync";

const deviceFilesApi = vi.hoisted(() => ({
  registerDevice: vi.fn(),
  updateDevice: vi.fn(),
  heartbeat: vi.fn(),
  reportSharedIndex: vi.fn(),
  fulfillRequest: vi.fn(),
}));
vi.mock("../api/deviceFiles", () => ({ deviceFilesApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";

function installApp(folder: Record<string, unknown> | null = null) {
  const bridge = {
    getInfo: () => JSON.stringify({ clientKey: "android-1", deviceName: "Pixel" }),
    pushToken: () => "token-1",
    getSharedFolder: () => JSON.stringify(folder),
    pickSharedFolderFor: vi.fn(),
    rememberPushDevice: vi.fn(),
  };
  (window as unknown as { AutomaNative: unknown }).AutomaNative = bridge;
  window.__automaKey = "page-key";
  return bridge;
}

async function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <DeviceFilesSync companyId={COMPANY} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return root;
}

describe("DeviceFilesSync", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    deviceFilesApi.heartbeat.mockResolvedValue({ device: { id: "device-1", sharedFolderName: null, autoFulfill: false }, pendingRequests: [] });
    deviceFilesApi.updateDevice.mockResolvedValue({ id: "device-1" });
  });
  afterEach(() => {
    delete (window as unknown as { AutomaNative?: unknown }).AutomaNative;
    delete window.__automaKey;
    vi.clearAllMocks();
  });

  it("registers the phone from any page, with its push token, and tells the app which server it is", async () => {
    const bridge = installApp();
    deviceFilesApi.registerDevice.mockResolvedValue({ id: "device-1" });
    const root = await mount();
    expect(deviceFilesApi.registerDevice).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ clientKey: "android-1", pushToken: "token-1" }));
    expect(bridge.rememberPushDevice).toHaveBeenCalledWith("page-key", "device-1");
    expect(deviceFilesApi.updateDevice).not.toHaveBeenCalled(); // the token went with the registration
    await act(async () => root.unmount());
  });

  it("stays removed once a person removed the phone", async () => {
    installApp();
    localStorage.setItem(`automa.device.${COMPANY}`, "device-1");
    deviceFilesApi.heartbeat.mockRejectedValue(new ApiError("This device was removed; register it again", 409, null));
    let root = await mount();
    expect(localStorage.getItem(`automa.device.${COMPANY}`)).toBeNull();
    await act(async () => root.unmount());
    root = await mount();
    expect(deviceFilesApi.registerDevice).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("tells the server to stop listing a folder that belongs to another organization", async () => {
    installApp({ name: "Contracts", companyId: "another-company" });
    localStorage.setItem(`automa.device.${COMPANY}`, "device-1");
    deviceFilesApi.heartbeat.mockResolvedValue({ device: { id: "device-1", sharedFolderName: "Photos", autoFulfill: true }, pendingRequests: [] });
    const root = await mount();
    expect(deviceFilesApi.reportSharedIndex).toHaveBeenCalledWith("device-1", { sharedFolderName: null, entries: [] });
    expect(deviceFilesApi.fulfillRequest).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
