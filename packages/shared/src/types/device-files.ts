/**
 * Device Files: move files between the devices a company's operators use
 * (phone, tablet, laptop browser) and the company's agents.
 *
 * - A **device** is registered by a board user from the Automa app or a
 *   browser. It may share one folder whose file listing (the shared index) it
 *   reports so agents can see what is available.
 * - A **device file** is a file stored in company storage that came from a
 *   device (or that an agent sent to a device).
 * - A **file request** is an agent (or board user) asking a device for a
 *   file. A person on the device fulfils it by picking a file, or the device
 *   fulfils it automatically when it shares the requested path and has
 *   auto-fulfil switched on.
 */

export const DEVICE_PLATFORMS = ["android", "ios", "web", "desktop", "other"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const DEVICE_FILE_REQUEST_STATUSES = ["pending", "fulfilled", "declined", "cancelled"] as const;
export type DeviceFileRequestStatus = (typeof DEVICE_FILE_REQUEST_STATUSES)[number];

/** Upper bound on the shared-folder listing a device may report. */
export const DEVICE_SHARED_INDEX_MAX_ENTRIES = 5000;

export interface DeviceSharedIndexEntry {
  /** Path relative to the shared folder root, using `/` separators. */
  path: string;
  byteSize: number | null;
  contentType: string | null;
  modifiedAt: string | null;
}

export interface CompanyDevice {
  id: string;
  companyId: string;
  name: string;
  platform: DevicePlatform;
  clientKey: string;
  registeredByUserId: string | null;
  sharedFolderName: string | null;
  sharedIndexCount: number;
  sharedIndexUpdatedAt: Date | null;
  autoFulfill: boolean;
  /** True when the device registered a push token (the token itself stays on the server). */
  pushEnabled: boolean;
  lastSeenAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyDeviceWithIndex extends CompanyDevice {
  sharedIndex: DeviceSharedIndexEntry[];
}

export interface DeviceFile {
  id: string;
  companyId: string;
  assetId: string;
  sourceDeviceId: string | null;
  targetDeviceId: string | null;
  issueId: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  devicePath: string | null;
  note: string | null;
  uploadedByAgentId: string | null;
  uploadedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** API path that streams the file bytes. */
  contentPath: string;
}

export interface DeviceFileRequest {
  id: string;
  companyId: string;
  deviceId: string | null;
  issueId: string | null;
  title: string;
  details: string | null;
  devicePath: string | null;
  acceptTypes: string | null;
  status: DeviceFileRequestStatus;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  fulfilledFileId: string | null;
  resolvedByUserId: string | null;
  resolvedByDeviceId: string | null;
  responseNote: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceFilesOverview {
  devices: CompanyDevice[];
  pendingRequestCount: number;
  fileCount: number;
}

export interface RegisterCompanyDeviceRequest {
  name: string;
  platform: DevicePlatform;
  clientKey: string;
  /** Firebase Cloud Messaging token (Automa Android app); null turns push off. */
  pushToken?: string | null;
}

export interface UpdateCompanyDeviceRequest {
  name?: string;
  autoFulfill?: boolean;
  pushToken?: string | null;
}

export interface ReportDeviceSharedIndexRequest {
  sharedFolderName: string | null;
  entries: DeviceSharedIndexEntry[];
}

export interface CreateDeviceFileRequestRequest {
  deviceId?: string | null;
  issueId?: string | null;
  title: string;
  details?: string | null;
  devicePath?: string | null;
  acceptTypes?: string | null;
}

export interface DeclineDeviceFileRequestRequest {
  deviceId?: string | null;
  note?: string | null;
}
