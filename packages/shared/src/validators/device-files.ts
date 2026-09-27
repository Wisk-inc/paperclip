import { z } from "zod";
import {
  DEVICE_FILE_REQUEST_STATUSES,
  DEVICE_PLATFORMS,
  DEVICE_SHARED_INDEX_MAX_ENTRIES,
} from "../types/device-files.js";

export const devicePlatformSchema = z.enum(DEVICE_PLATFORMS);
export const deviceFileRequestStatusSchema = z.enum(DEVICE_FILE_REQUEST_STATUSES);

/**
 * A path inside a device's shared folder. Relative, `/`-separated, with no
 * `.`/`..` segments, so it can never name anything outside the folder the
 * person chose to share.
 */
export const deviceSharedPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/") && !value.includes("\\"), {
    message: "Device paths are relative and use / separators",
  })
  .refine((value) => value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), {
    message: "Device paths cannot contain empty, . or .. segments",
  });

export const deviceClientKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "Device client keys use letters, numbers, and . _ : -");

export const registerCompanyDeviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  platform: devicePlatformSchema,
  clientKey: deviceClientKeySchema,
});

export const updateCompanyDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    autoFulfill: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one device field is required",
  });

export const deviceSharedIndexEntrySchema = z.object({
  path: deviceSharedPathSchema,
  byteSize: z.number().int().nonnegative().nullable(),
  contentType: z.string().trim().max(255).nullable(),
  modifiedAt: z.string().trim().max(64).nullable(),
});

export const reportDeviceSharedIndexSchema = z.object({
  sharedFolderName: z.string().trim().min(1).max(255).nullable(),
  entries: z.array(deviceSharedIndexEntrySchema).max(DEVICE_SHARED_INDEX_MAX_ENTRIES),
});

export const createDeviceFileRequestSchema = z.object({
  deviceId: z.string().guid().optional().nullable(),
  issueId: z.string().guid().optional().nullable(),
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().max(4000).optional().nullable(),
  devicePath: deviceSharedPathSchema.optional().nullable(),
  acceptTypes: z.string().trim().max(255).optional().nullable(),
});

export const declineDeviceFileRequestSchema = z.object({
  deviceId: z.string().guid().optional().nullable(),
  note: z.string().trim().max(2000).optional().nullable(),
});

export const listDeviceFileRequestsQuerySchema = z.object({
  status: deviceFileRequestStatusSchema.optional(),
  deviceId: z.string().guid().optional(),
});

export type RegisterCompanyDevice = z.infer<typeof registerCompanyDeviceSchema>;
export type UpdateCompanyDevice = z.infer<typeof updateCompanyDeviceSchema>;
export type ReportDeviceSharedIndex = z.infer<typeof reportDeviceSharedIndexSchema>;
export type CreateDeviceFileRequest = z.infer<typeof createDeviceFileRequestSchema>;
export type DeclineDeviceFileRequest = z.infer<typeof declineDeviceFileRequestSchema>;
