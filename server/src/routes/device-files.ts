import { Router, type Request, type Response } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { assets, issues, type Db } from "@paperclipai/db";
import {
  createDeviceFileRequestSchema,
  declineDeviceFileRequestSchema,
  deviceSharedPathSchema,
  listDeviceFileRequestsQuerySchema,
  registerCompanyDeviceSchema,
  reportDeviceSharedIndexSchema,
  updateCompanyDeviceSchema,
  type DeviceFileRequest,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { assetService, heartbeatService, logActivity } from "../services/index.js";
import {
  deviceFileService,
  toDeviceFile,
  withoutSharedIndex,
} from "../services/device-files.js";
import {
  formatAttachmentSize,
  isInlineAttachmentContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeUploadAttachmentContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

const DEVICE_FILES_NAMESPACE = "device-files";

const optionalUuidField = z
  .string()
  .trim()
  .transform((value) => (value.length > 0 ? value : null))
  .pipe(z.string().guid().nullable())
  .optional();

const optionalTextField = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length > 0 ? value : null))
    .optional();

/** Multipart text fields that ride along with an uploaded device file. */
const deviceFileUploadFieldsSchema = z.object({
  sourceDeviceId: optionalUuidField,
  targetDeviceId: optionalUuidField,
  issueId: optionalUuidField,
  note: optionalTextField(2000),
  devicePath: z
    .string()
    .trim()
    .transform((value) => (value.length > 0 ? value : null))
    .pipe(deviceSharedPathSchema.nullable())
    .optional(),
});

const fulfilFieldsSchema = z.object({
  deviceId: optionalUuidField,
  note: optionalTextField(2000),
  devicePath: deviceFileUploadFieldsSchema.shape.devicePath,
});

type UploadedFile = { mimetype: string; buffer: Buffer; originalname: string; size: number };

/**
 * Multer decodes multipart filenames as latin1. Browsers and the Automa app
 * send UTF-8, so re-decode when the result is valid UTF-8; phone files often
 * carry non-ASCII names.
 */
export function decodeUploadFilename(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "file";
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  const cleaned = (decoded.includes("\uFFFD") ? value : decoded)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]/)
    .pop()
    ?.trim();
  return cleaned && cleaned.length > 0 ? cleaned.slice(0, 255) : "file";
}

/** RFC 6266 Content-Disposition with an ASCII fallback plus a UTF-8 name. */
export function contentDisposition(kind: "inline" | "attachment", filename: string) {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "file";
  return `${kind}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function deviceFileRoutes(
  db: Db,
  storage: StorageService,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = deviceFileService(db);
  const assetsSvc = assetService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  async function receiveFile(req: Request, res: Response): Promise<UploadedFile | null> {
    try {
      await new Promise<void>((resolve, reject) => {
        upload.single("file")(req, res, (err: unknown) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({
            error: `File is larger than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} limit`,
          });
          return null;
        }
        res.status(400).json({ error: err.message });
        return null;
      }
      throw err;
    }
    const file = (req as Request & { file?: UploadedFile }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return null;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "File is empty" });
      return null;
    }
    return file;
  }

  async function requireCompanyDevice(companyId: string, deviceId: string | null | undefined) {
    if (!deviceId) return null;
    const device = await svc.getDevice(deviceId);
    if (!device || device.companyId !== companyId || device.archivedAt) {
      throw badRequest("Device not found in this company");
    }
    return device;
  }

  async function requireCompanyIssue(companyId: string, issueId: string | null | undefined) {
    if (!issueId) return null;
    const issue = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw badRequest("Issue not found in this company");
    return issue;
  }

  async function storeDeviceFile(
    req: Request,
    companyId: string,
    file: UploadedFile,
    fields: {
      sourceDeviceId: string | null;
      targetDeviceId: string | null;
      issueId: string | null;
      note: string | null;
      devicePath: string | null;
    },
  ) {
    const actor = getActorInfo(req);
    const filename = decodeUploadFilename(file.originalname);
    const contentType = normalizeUploadAttachmentContentType({
      contentType: file.mimetype,
      originalFilename: filename,
    });
    const stored = await storage.putFile({
      companyId,
      namespace: DEVICE_FILES_NAMESPACE,
      originalFilename: filename,
      contentType,
      body: file.buffer,
    });
    const asset = await assetsSvc.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    return svc.createFile(companyId, {
      assetId: asset!.id,
      sourceDeviceId: fields.sourceDeviceId,
      targetDeviceId: fields.targetDeviceId,
      issueId: fields.issueId,
      filename,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      devicePath: fields.devicePath,
      note: fields.note,
      uploadedByAgentId: actor.agentId,
      uploadedByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
  }

  async function wakeRequester(
    req: Request,
    request: DeviceFileRequest,
    reason: "device_file_request_fulfilled" | "device_file_request_declined",
  ) {
    if (!request.requestedByAgentId) return;
    const actor = getActorInfo(req);
    const context = {
      deviceFileRequestId: request.id,
      deviceFileRequestStatus: request.status,
      deviceFileId: request.fulfilledFileId,
      deviceFileContentPath: request.fulfilledFileId ? `/api/device-files/${request.fulfilledFileId}/content` : null,
      issueId: request.issueId,
    };
    try {
      const run = await heartbeat.wakeup(request.requestedByAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason,
        payload: context,
        requestedByActorType: "user",
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          source: reason === "device_file_request_fulfilled" ? "device_file_request.fulfilled" : "device_file_request.declined",
          ...context,
          ...(request.issueId ? { taskId: request.issueId } : {}),
          wakeReason: reason,
        },
      });
      await logActivity(db, {
        companyId: request.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "device_file_request.requester_wakeup_queued",
        entityType: "device_file_request",
        entityId: request.id,
        details: { requesterAgentId: request.requestedByAgentId, wakeRunId: run?.id ?? null },
      });
    } catch (err) {
      logger.warn(
        { err, requestId: request.id, agentId: request.requestedByAgentId },
        "Failed to wake agent after device file request resolution",
      );
    }
  }

  // ─── Devices ──────────────────────────────────────────────────────────────

  router.get("/companies/:companyId/devices", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const devices = await svc.listDevices(companyId, { includeArchived: req.query.includeArchived === "true" });
    res.json(devices);
  });

  router.get("/companies/:companyId/device-files/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const [devices, pendingRequestCount, fileCount] = await Promise.all([
      svc.listDevices(companyId),
      svc.countPendingRequests(companyId),
      svc.countFiles(companyId),
    ]);
    res.json({ devices, pendingRequestCount, fileCount });
  });

  router.post("/companies/:companyId/devices", validate(registerCompanyDeviceSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const { device, created } = await svc.registerDevice(
      companyId,
      req.body,
      actor.actorType === "user" ? actor.actorId : null,
    );
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: created ? "device.registered" : "device.reregistered",
      entityType: "device",
      entityId: device.id,
      details: { name: device.name, platform: device.platform },
    });
    res.status(created ? 201 : 200).json(withoutSharedIndex(device));
  });

  router.get("/devices/:deviceId", async (req, res) => {
    const device = await getAccessibleResource(req, res, svc.getDevice(req.params.deviceId as string), "Device not found");
    if (!device) return;
    res.json(device);
  });

  router.patch("/devices/:deviceId", validate(updateCompanyDeviceSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getDevice(req.params.deviceId as string), "Device not found");
    if (!existing) return;
    assertBoard(req);
    if (req.body.autoFulfill === true && !existing.sharedFolderName) {
      throw badRequest("Share a folder from this device before turning on auto-fulfil");
    }
    const updated = await svc.updateDevice(existing.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "device.updated",
      entityType: "device",
      entityId: existing.id,
      details: { name: updated?.name ?? existing.name, autoFulfill: updated?.autoFulfill ?? existing.autoFulfill },
    });
    res.json(updated ? withoutSharedIndex(updated) : null);
  });

  /**
   * Called by a device while it is open. Records that it is online and hands
   * back the pending requests it can answer, so a phone can prompt its owner
   * (or auto-fulfil from its shared folder) without a separate poll.
   */
  router.post("/devices/:deviceId/heartbeat", async (req, res) => {
    const device = await getAccessibleResource(req, res, svc.getDevice(req.params.deviceId as string), "Device not found");
    if (!device) return;
    assertBoard(req);
    if (device.archivedAt) throw conflict("This device was removed; register it again");
    const lastSeenAt = await svc.touchDevice(device.id);
    const pendingRequests = await svc.listRequests(device.companyId, { status: "pending", deviceId: device.id });
    res.json({ device: { ...withoutSharedIndex(device), lastSeenAt }, pendingRequests });
  });

  router.put("/devices/:deviceId/shared-index", validate(reportDeviceSharedIndexSchema), async (req, res) => {
    const device = await getAccessibleResource(req, res, svc.getDevice(req.params.deviceId as string), "Device not found");
    if (!device) return;
    assertBoard(req);
    if (device.archivedAt) throw conflict("This device was removed; register it again");
    const updated = await svc.reportSharedIndex(device.id, req.body);
    const sharingChanged = device.sharedFolderName !== (updated?.sharedFolderName ?? null);
    if (sharingChanged) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: device.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: updated?.sharedFolderName ? "device.folder_shared" : "device.folder_unshared",
        entityType: "device",
        entityId: device.id,
        details: { sharedFolderName: updated?.sharedFolderName ?? null, entryCount: updated?.sharedIndexCount ?? 0 },
      });
    }
    res.json(updated ? withoutSharedIndex(updated) : null);
  });

  router.delete("/devices/:deviceId", async (req, res) => {
    const device = await getAccessibleResource(req, res, svc.getDevice(req.params.deviceId as string), "Device not found");
    if (!device) return;
    assertBoard(req);
    const archived = await svc.archiveDevice(device.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: device.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "device.removed",
      entityType: "device",
      entityId: device.id,
      details: { name: device.name },
    });
    res.json(archived ? withoutSharedIndex(archived) : null);
  });

  // ─── Files ────────────────────────────────────────────────────────────────

  router.get("/companies/:companyId/device-files", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const pickId = (value: unknown) => (typeof value === "string" && z.string().guid().safeParse(value).success ? value : undefined);
    const files = await svc.listFiles(companyId, {
      sourceDeviceId: pickId(req.query.sourceDeviceId),
      targetDeviceId: pickId(req.query.targetDeviceId),
      issueId: pickId(req.query.issueId),
    });
    res.json(files);
  });

  router.post("/companies/:companyId/device-files", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const file = await receiveFile(req, res);
    if (!file) return;
    const parsed = deviceFileUploadFieldsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid device file fields", details: parsed.error.issues });
      return;
    }
    const fields = parsed.data;
    if (req.actor.type === "agent" && fields.sourceDeviceId) {
      throw forbidden("Agents send files to devices; only a device can be a file source");
    }
    await requireCompanyDevice(companyId, fields.sourceDeviceId);
    await requireCompanyDevice(companyId, fields.targetDeviceId);
    await requireCompanyIssue(companyId, fields.issueId);

    const created = await storeDeviceFile(req, companyId, file, {
      sourceDeviceId: fields.sourceDeviceId ?? null,
      targetDeviceId: fields.targetDeviceId ?? null,
      issueId: fields.issueId ?? null,
      note: fields.note ?? null,
      devicePath: fields.devicePath ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "device_file.uploaded",
      entityType: "device_file",
      entityId: created.id,
      details: {
        filename: created.filename,
        contentType: created.contentType,
        byteSize: created.byteSize,
        sourceDeviceId: created.sourceDeviceId,
        targetDeviceId: created.targetDeviceId,
        issueId: created.issueId,
      },
    });
    res.status(201).json(created);
  });

  router.get("/device-files/:fileId", async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getFile(req.params.fileId as string), "Device file not found");
    if (!row) return;
    res.json(toDeviceFile(row));
  });

  router.get("/device-files/:fileId/content", async (req, res, next) => {
    const row = await getAccessibleResource(req, res, svc.getFile(req.params.fileId as string), "Device file not found");
    if (!row) return;
    const asset = await assetsSvc.getById(row.assetId);
    if (!asset || asset.companyId !== row.companyId) throw notFound("Device file content not found");
    const object = await storage.getObject(asset.companyId, asset.objectKey);
    const contentType = row.contentType || object.contentType || "application/octet-stream";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const forceDownload = req.query.download === "1" || req.query.download === "true";
    const inlineSafe = !forceDownload && mediaType !== SVG_CONTENT_TYPE && isInlineAttachmentContentType(mediaType);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(row.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!inlineSafe) res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader("Content-Disposition", contentDisposition(inlineSafe ? "inline" : "attachment", row.filename));
    object.stream.on("error", (err) => next(err));
    object.stream.pipe(res);
  });

  router.delete("/device-files/:fileId", async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getFile(req.params.fileId as string), "Device file not found");
    if (!row) return;
    const actor = getActorInfo(req);
    if (actor.actorType === "agent" && row.uploadedByAgentId !== actor.agentId) {
      throw forbidden("Agents can only delete device files they uploaded");
    }
    const deleted = await svc.deleteFile(row.id);
    if (!deleted) throw notFound("Device file not found");
    const asset = await assetsSvc.getById(row.assetId);
    if (asset) {
      await db.delete(assets).where(eq(assets.id, asset.id));
      try {
        await storage.deleteObject(asset.companyId, asset.objectKey);
      } catch (err) {
        logger.warn({ err, fileId: row.id, assetId: asset.id }, "Failed to delete device file object from storage");
      }
    }
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "device_file.deleted",
      entityType: "device_file",
      entityId: row.id,
      details: { filename: row.filename },
    });
    res.json({ ok: true, id: row.id });
  });

  // ─── File requests ────────────────────────────────────────────────────────

  router.get("/companies/:companyId/device-file-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = listDeviceFileRequestsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    res.json(await svc.listRequests(companyId, parsed.data));
  });

  router.post(
    "/companies/:companyId/device-file-requests",
    validate(createDeviceFileRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await requireCompanyDevice(companyId, req.body.deviceId);
      await requireCompanyIssue(companyId, req.body.issueId);
      const actor = getActorInfo(req);
      const created = await svc.createRequest(companyId, {
        deviceId: req.body.deviceId ?? null,
        issueId: req.body.issueId ?? null,
        title: req.body.title,
        details: req.body.details ?? null,
        devicePath: req.body.devicePath ?? null,
        acceptTypes: req.body.acceptTypes ?? null,
        requestedByAgentId: actor.agentId,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "device_file_request.created",
        entityType: "device_file_request",
        entityId: created.id,
        details: {
          title: created.title,
          deviceId: created.deviceId,
          devicePath: created.devicePath,
          issueId: created.issueId,
        },
      });
      res.status(201).json(created);
    },
  );

  router.get("/device-file-requests/:requestId", async (req, res) => {
    const row = await getAccessibleResource(
      req,
      res,
      svc.getRequest(req.params.requestId as string),
      "Device file request not found",
    );
    if (!row) return;
    const file = row.fulfilledFileId ? await svc.getFile(row.fulfilledFileId) : null;
    res.json({ ...row, file: file ? toDeviceFile(file) : null });
  });

  router.post("/device-file-requests/:requestId/fulfill", async (req, res) => {
    const row = await getAccessibleResource(
      req,
      res,
      svc.getRequest(req.params.requestId as string),
      "Device file request not found",
    );
    if (!row) return;
    assertBoard(req);
    if (row.status !== "pending") throw conflict(`This request is already ${row.status}`);
    const file = await receiveFile(req, res);
    if (!file) return;
    const parsed = fulfilFieldsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid fulfil fields", details: parsed.error.issues });
      return;
    }
    const deviceId = parsed.data.deviceId ?? null;
    await requireCompanyDevice(row.companyId, deviceId);
    if (row.deviceId && deviceId && row.deviceId !== deviceId) {
      throw forbidden("This request is addressed to a different device");
    }

    const stored = await storeDeviceFile(req, row.companyId, file, {
      sourceDeviceId: deviceId,
      targetDeviceId: null,
      issueId: row.issueId,
      note: parsed.data.note ?? null,
      devicePath: parsed.data.devicePath ?? row.devicePath ?? null,
    });
    const actor = getActorInfo(req);
    const resolved = await svc.resolveRequest(row.id, {
      status: "fulfilled",
      fulfilledFileId: stored.id,
      resolvedByUserId: actor.actorType === "user" ? actor.actorId : null,
      resolvedByDeviceId: deviceId,
      responseNote: parsed.data.note ?? null,
    });
    if (!resolved) {
      // Another device answered first. Keep the upload (it is still a valid
      // device file) but tell this caller the request was already resolved.
      throw conflict("This request was answered by another device first");
    }
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "device_file_request.fulfilled",
      entityType: "device_file_request",
      entityId: row.id,
      details: {
        deviceFileId: stored.id,
        filename: stored.filename,
        byteSize: stored.byteSize,
        deviceId,
        requestedByAgentId: row.requestedByAgentId,
      },
    });
    await wakeRequester(req, resolved, "device_file_request_fulfilled");
    res.json({ ...resolved, file: stored });
  });

  router.post(
    "/device-file-requests/:requestId/decline",
    validate(declineDeviceFileRequestSchema),
    async (req, res) => {
      const row = await getAccessibleResource(
        req,
        res,
        svc.getRequest(req.params.requestId as string),
        "Device file request not found",
      );
      if (!row) return;
      assertBoard(req);
      const deviceId = req.body.deviceId ?? null;
      await requireCompanyDevice(row.companyId, deviceId);
      const actor = getActorInfo(req);
      const resolved = await svc.resolveRequest(row.id, {
        status: "declined",
        resolvedByUserId: actor.actorType === "user" ? actor.actorId : null,
        resolvedByDeviceId: deviceId,
        responseNote: req.body.note ?? null,
      });
      if (!resolved) throw conflict(`This request is already ${row.status}`);
      await logActivity(db, {
        companyId: row.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "device_file_request.declined",
        entityType: "device_file_request",
        entityId: row.id,
        details: { deviceId, note: resolved.responseNote, requestedByAgentId: row.requestedByAgentId },
      });
      await wakeRequester(req, resolved, "device_file_request_declined");
      res.json(resolved);
    },
  );

  router.post("/device-file-requests/:requestId/cancel", async (req, res) => {
    const row = await getAccessibleResource(
      req,
      res,
      svc.getRequest(req.params.requestId as string),
      "Device file request not found",
    );
    if (!row) return;
    const actor = getActorInfo(req);
    if (actor.actorType === "agent" && row.requestedByAgentId !== actor.agentId) {
      throw forbidden("Agents can only cancel their own file requests");
    }
    const resolved = await svc.resolveRequest(row.id, {
      status: "cancelled",
      resolvedByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!resolved) throw conflict(`This request is already ${row.status}`);
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "device_file_request.cancelled",
      entityType: "device_file_request",
      entityId: row.id,
      details: { title: row.title },
    });
    res.json(resolved);
  });

  return router;
}
