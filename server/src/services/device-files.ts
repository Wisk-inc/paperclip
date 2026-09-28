import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyDevices, deviceFileRequests, deviceFiles } from "@paperclipai/db";
import type {
  CompanyDevice,
  CompanyDeviceWithIndex,
  DeviceFile,
  DeviceFileRequest,
  DeviceFileRequestStatus,
  DevicePlatform,
  DeviceSharedIndexEntry,
} from "@paperclipai/shared";

type DeviceRow = typeof companyDevices.$inferSelect;
type DeviceFileRow = typeof deviceFiles.$inferSelect;
type DeviceFileRequestRow = typeof deviceFileRequests.$inferSelect;

const DEVICE_LIST_LIMIT = 200;
const DEVICE_FILE_LIST_LIMIT = 500;
const DEVICE_FILE_REQUEST_LIST_LIMIT = 500;

const deviceSummaryColumns = {
  id: companyDevices.id,
  companyId: companyDevices.companyId,
  name: companyDevices.name,
  platform: companyDevices.platform,
  clientKey: companyDevices.clientKey,
  registeredByUserId: companyDevices.registeredByUserId,
  sharedFolderName: companyDevices.sharedFolderName,
  sharedIndexCount: sql<number>`jsonb_array_length(${companyDevices.sharedIndex})`.mapWith(Number),
  sharedIndexUpdatedAt: companyDevices.sharedIndexUpdatedAt,
  autoFulfill: companyDevices.autoFulfill,
  pushEnabled: sql<boolean>`${companyDevices.pushToken} is not null`.mapWith(Boolean),
  lastSeenAt: companyDevices.lastSeenAt,
  archivedAt: companyDevices.archivedAt,
  createdAt: companyDevices.createdAt,
  updatedAt: companyDevices.updatedAt,
};

export function deviceFileContentPath(fileId: string) {
  return `/api/device-files/${fileId}/content`;
}

export function toCompanyDevice(row: DeviceRow): CompanyDeviceWithIndex {
  const sharedIndex = Array.isArray(row.sharedIndex) ? row.sharedIndex : [];
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    platform: row.platform,
    clientKey: row.clientKey,
    registeredByUserId: row.registeredByUserId,
    sharedFolderName: row.sharedFolderName,
    sharedIndexCount: sharedIndex.length,
    sharedIndexUpdatedAt: row.sharedIndexUpdatedAt,
    autoFulfill: row.autoFulfill,
    pushEnabled: row.pushToken !== null,
    lastSeenAt: row.lastSeenAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sharedIndex,
  };
}

export function withoutSharedIndex(device: CompanyDeviceWithIndex): CompanyDevice {
  const { sharedIndex: _sharedIndex, ...summary } = device;
  return summary;
}

export function toDeviceFile(row: DeviceFileRow): DeviceFile {
  return {
    id: row.id,
    companyId: row.companyId,
    assetId: row.assetId,
    sourceDeviceId: row.sourceDeviceId,
    targetDeviceId: row.targetDeviceId,
    issueId: row.issueId,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    devicePath: row.devicePath,
    note: row.note,
    uploadedByAgentId: row.uploadedByAgentId,
    uploadedByUserId: row.uploadedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contentPath: deviceFileContentPath(row.id),
  };
}

export function toDeviceFileRequest(row: DeviceFileRequestRow): DeviceFileRequest {
  return {
    id: row.id,
    companyId: row.companyId,
    deviceId: row.deviceId,
    issueId: row.issueId,
    title: row.title,
    details: row.details,
    devicePath: row.devicePath,
    acceptTypes: row.acceptTypes,
    status: row.status,
    requestedByAgentId: row.requestedByAgentId,
    requestedByUserId: row.requestedByUserId,
    fulfilledFileId: row.fulfilledFileId,
    resolvedByUserId: row.resolvedByUserId,
    resolvedByDeviceId: row.resolvedByDeviceId,
    responseNote: row.responseNote,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Keep only the first entry for each path so agents never see duplicates. */
export function normalizeSharedIndex(entries: DeviceSharedIndexEntry[]): DeviceSharedIndexEntry[] {
  const seen = new Set<string>();
  const normalized: DeviceSharedIndexEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    normalized.push({
      path: entry.path,
      byteSize: entry.byteSize ?? null,
      contentType: entry.contentType ?? null,
      modifiedAt: entry.modifiedAt ?? null,
    });
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

export function deviceFileService(db: Db) {
  return {
    listDevices: async (companyId: string, options: { includeArchived?: boolean } = {}): Promise<CompanyDevice[]> => {
      const conditions: SQL[] = [eq(companyDevices.companyId, companyId)];
      if (!options.includeArchived) conditions.push(isNull(companyDevices.archivedAt));
      const rows = await db
        .select(deviceSummaryColumns)
        .from(companyDevices)
        .where(and(...conditions))
        .orderBy(desc(companyDevices.lastSeenAt), desc(companyDevices.createdAt))
        .limit(DEVICE_LIST_LIMIT);
      return rows;
    },

    getDevice: async (deviceId: string): Promise<CompanyDeviceWithIndex | null> => {
      const row = await db
        .select()
        .from(companyDevices)
        .where(eq(companyDevices.id, deviceId))
        .then((rows) => rows[0] ?? null);
      return row ? toCompanyDevice(row) : null;
    },

    /**
     * Register a device, or refresh the existing registration for the same
     * install (matched by client key). Re-registering restores an archived
     * device so reinstalling the app never strands its history.
     */
    registerDevice: async (
      companyId: string,
      input: { name: string; platform: DevicePlatform; clientKey: string; pushToken?: string | null },
      registeredByUserId: string | null,
    ): Promise<{ device: CompanyDeviceWithIndex; created: boolean }> => {
      const now = new Date();
      const existing = await db
        .select()
        .from(companyDevices)
        .where(and(eq(companyDevices.companyId, companyId), eq(companyDevices.clientKey, input.clientKey)))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const [updated] = await db
          .update(companyDevices)
          .set({
            name: input.name,
            platform: input.platform,
            ...(input.pushToken !== undefined ? { pushToken: input.pushToken } : {}),
            archivedAt: null,
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(companyDevices.id, existing.id))
          .returning();
        return { device: toCompanyDevice(updated!), created: false };
      }
      const [created] = await db
        .insert(companyDevices)
        .values({
          companyId,
          name: input.name,
          platform: input.platform,
          clientKey: input.clientKey,
          registeredByUserId,
          pushToken: input.pushToken ?? null,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [companyDevices.companyId, companyDevices.clientKey],
          set: {
            name: input.name,
            platform: input.platform,
            ...(input.pushToken !== undefined ? { pushToken: input.pushToken } : {}),
            archivedAt: null,
            lastSeenAt: now,
            updatedAt: now,
          },
        })
        .returning();
      return { device: toCompanyDevice(created!), created: true };
    },

    updateDevice: async (
      deviceId: string,
      patch: { name?: string; autoFulfill?: boolean; pushToken?: string | null },
    ): Promise<CompanyDeviceWithIndex | null> => {
      const [updated] = await db
        .update(companyDevices)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.autoFulfill !== undefined ? { autoFulfill: patch.autoFulfill } : {}),
          ...(patch.pushToken !== undefined ? { pushToken: patch.pushToken } : {}),
          updatedAt: new Date(),
        })
        .where(eq(companyDevices.id, deviceId))
        .returning();
      return updated ? toCompanyDevice(updated) : null;
    },

    /**
     * Push targets for a company: one device, or every active device when
     * `deviceId` is null (a request any device can answer).
     */
    listPushTargets: async (companyId: string, deviceId: string | null): Promise<{ deviceId: string; token: string }[]> => {
      const rows = await db
        .select({ deviceId: companyDevices.id, token: companyDevices.pushToken })
        .from(companyDevices)
        .where(
          and(
            eq(companyDevices.companyId, companyId),
            isNull(companyDevices.archivedAt),
            isNotNull(companyDevices.pushToken),
            ...(deviceId ? [eq(companyDevices.id, deviceId)] : []),
          ),
        );
      return rows.flatMap((row) => (row.token ? [{ deviceId: row.deviceId, token: row.token }] : []));
    },

    /** Forget push tokens that Firebase reported as no longer registered. */
    clearPushTokens: async (tokens: string[]) => {
      if (tokens.length === 0) return;
      await db.update(companyDevices).set({ pushToken: null }).where(inArray(companyDevices.pushToken, tokens));
    },

    touchDevice: async (deviceId: string) => {
      const now = new Date();
      await db
        .update(companyDevices)
        .set({ lastSeenAt: now })
        .where(eq(companyDevices.id, deviceId));
      return now;
    },

    reportSharedIndex: async (
      deviceId: string,
      input: { sharedFolderName: string | null; entries: DeviceSharedIndexEntry[] },
    ): Promise<CompanyDeviceWithIndex | null> => {
      const now = new Date();
      const entries = input.sharedFolderName ? normalizeSharedIndex(input.entries) : [];
      const [updated] = await db
        .update(companyDevices)
        .set({
          sharedFolderName: input.sharedFolderName,
          sharedIndex: entries,
          sharedIndexUpdatedAt: now,
          // Auto-fulfil only makes sense while a folder is shared.
          ...(input.sharedFolderName ? {} : { autoFulfill: false }),
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(companyDevices.id, deviceId))
        .returning();
      return updated ? toCompanyDevice(updated) : null;
    },

    archiveDevice: async (deviceId: string): Promise<CompanyDeviceWithIndex | null> => {
      const now = new Date();
      const [updated] = await db
        .update(companyDevices)
        .set({
          archivedAt: now,
          autoFulfill: false,
          sharedFolderName: null,
          sharedIndex: [],
          pushToken: null,
          updatedAt: now,
        })
        .where(eq(companyDevices.id, deviceId))
        .returning();
      return updated ? toCompanyDevice(updated) : null;
    },

    listFiles: async (
      companyId: string,
      filters: { sourceDeviceId?: string; targetDeviceId?: string; issueId?: string } = {},
    ): Promise<DeviceFile[]> => {
      const conditions: SQL[] = [eq(deviceFiles.companyId, companyId)];
      if (filters.sourceDeviceId) conditions.push(eq(deviceFiles.sourceDeviceId, filters.sourceDeviceId));
      if (filters.targetDeviceId) conditions.push(eq(deviceFiles.targetDeviceId, filters.targetDeviceId));
      if (filters.issueId) conditions.push(eq(deviceFiles.issueId, filters.issueId));
      const rows = await db
        .select()
        .from(deviceFiles)
        .where(and(...conditions))
        .orderBy(desc(deviceFiles.createdAt))
        .limit(DEVICE_FILE_LIST_LIMIT);
      return rows.map(toDeviceFile);
    },

    getFile: async (fileId: string) =>
      db
        .select()
        .from(deviceFiles)
        .where(eq(deviceFiles.id, fileId))
        .then((rows) => rows[0] ?? null),

    createFile: async (
      companyId: string,
      data: Omit<typeof deviceFiles.$inferInsert, "companyId" | "id" | "createdAt" | "updatedAt">,
    ): Promise<DeviceFile> => {
      const [row] = await db
        .insert(deviceFiles)
        .values({ ...data, companyId })
        .returning();
      return toDeviceFile(row!);
    },

    deleteFile: async (fileId: string) => {
      const [row] = await db.delete(deviceFiles).where(eq(deviceFiles.id, fileId)).returning();
      return row ?? null;
    },

    listRequests: async (
      companyId: string,
      filters: { status?: DeviceFileRequestStatus; deviceId?: string } = {},
    ): Promise<DeviceFileRequest[]> => {
      const conditions: SQL[] = [eq(deviceFileRequests.companyId, companyId)];
      if (filters.status) conditions.push(eq(deviceFileRequests.status, filters.status));
      if (filters.deviceId) {
        // A device sees requests addressed to it plus requests any device may answer.
        conditions.push(or(eq(deviceFileRequests.deviceId, filters.deviceId), isNull(deviceFileRequests.deviceId))!);
      }
      const rows = await db
        .select()
        .from(deviceFileRequests)
        .where(and(...conditions))
        .orderBy(desc(deviceFileRequests.createdAt))
        .limit(DEVICE_FILE_REQUEST_LIST_LIMIT);
      return rows.map(toDeviceFileRequest);
    },

    countPendingRequests: async (companyId: string) =>
      db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(deviceFileRequests)
        .where(and(eq(deviceFileRequests.companyId, companyId), eq(deviceFileRequests.status, "pending")))
        .then((rows) => rows[0]?.count ?? 0),

    countFiles: async (companyId: string) =>
      db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(deviceFiles)
        .where(eq(deviceFiles.companyId, companyId))
        .then((rows) => rows[0]?.count ?? 0),

    getRequest: async (requestId: string) =>
      db
        .select()
        .from(deviceFileRequests)
        .where(eq(deviceFileRequests.id, requestId))
        .then((rows) => rows[0] ?? null),

    createRequest: async (
      companyId: string,
      data: Omit<
        typeof deviceFileRequests.$inferInsert,
        "companyId" | "id" | "status" | "createdAt" | "updatedAt" | "resolvedAt"
      >,
    ): Promise<DeviceFileRequest> => {
      const [row] = await db
        .insert(deviceFileRequests)
        .values({ ...data, companyId, status: "pending" })
        .returning();
      return toDeviceFileRequest(row!);
    },

    /**
     * Move a pending request to a terminal status. The update is conditional
     * on the request still being pending, so two devices answering at once
     * cannot both fulfil it: the loser gets `null` back.
     */
    resolveRequest: async (
      requestId: string,
      resolution: {
        status: Exclude<DeviceFileRequestStatus, "pending">;
        fulfilledFileId?: string | null;
        resolvedByUserId?: string | null;
        resolvedByDeviceId?: string | null;
        responseNote?: string | null;
      },
    ): Promise<DeviceFileRequest | null> => {
      const now = new Date();
      const [row] = await db
        .update(deviceFileRequests)
        .set({
          status: resolution.status,
          fulfilledFileId: resolution.fulfilledFileId ?? null,
          resolvedByUserId: resolution.resolvedByUserId ?? null,
          resolvedByDeviceId: resolution.resolvedByDeviceId ?? null,
          responseNote: resolution.responseNote ?? null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(and(eq(deviceFileRequests.id, requestId), eq(deviceFileRequests.status, "pending")))
        .returning();
      return row ? toDeviceFileRequest(row) : null;
    },
  };
}

export type DeviceFileService = ReturnType<typeof deviceFileService>;
