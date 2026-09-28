import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  DeviceFileRequestStatus,
  DevicePlatform,
  DeviceSharedIndexEntry,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { assets } from "./assets.js";
import { issues } from "./issues.js";

/**
 * A phone, tablet, or browser that a board user registered with a company so
 * files can move between it and the company's agents.
 */
export const companyDevices = pgTable(
  "company_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").$type<DevicePlatform>().notNull().default("web"),
    // Stable per-install key generated on the device; re-registering the same
    // install updates the existing row instead of creating a duplicate.
    clientKey: text("client_key").notNull(),
    registeredByUserId: text("registered_by_user_id"),
    sharedFolderName: text("shared_folder_name"),
    sharedIndex: jsonb("shared_index").$type<DeviceSharedIndexEntry[]>().notNull().default([]),
    sharedIndexUpdatedAt: timestamp("shared_index_updated_at", { withTimezone: true }),
    autoFulfill: boolean("auto_fulfill").notNull().default(false),
    // Firebase Cloud Messaging token of the Automa Android app on this device.
    // Server-only: never returned by the API (devices expose `pushEnabled`).
    pushToken: text("push_token"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("company_devices_company_created_idx").on(table.companyId, table.createdAt),
    companyClientKeyUq: uniqueIndex("company_devices_company_client_key_uq").on(table.companyId, table.clientKey),
  }),
);

/** A file that came from a device, or that an agent sent to a device. */
export const deviceFiles = pgTable(
  "device_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id),
    sourceDeviceId: uuid("source_device_id").references(() => companyDevices.id, { onDelete: "set null" }),
    targetDeviceId: uuid("target_device_id").references(() => companyDevices.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    devicePath: text("device_path"),
    note: text("note"),
    uploadedByAgentId: uuid("uploaded_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    uploadedByUserId: text("uploaded_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("device_files_company_created_idx").on(table.companyId, table.createdAt),
    companySourceIdx: index("device_files_company_source_idx").on(table.companyId, table.sourceDeviceId),
    companyTargetIdx: index("device_files_company_target_idx").on(table.companyId, table.targetDeviceId),
  }),
);

/** An agent (or board user) asking a device for a file. */
export const deviceFileRequests = pgTable(
  "device_file_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Null means any of the company's devices may answer.
    deviceId: uuid("device_id").references(() => companyDevices.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    details: text("details"),
    devicePath: text("device_path"),
    acceptTypes: text("accept_types"),
    status: text("status").$type<DeviceFileRequestStatus>().notNull().default("pending"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByUserId: text("requested_by_user_id"),
    fulfilledFileId: uuid("fulfilled_file_id").references(() => deviceFiles.id, { onDelete: "set null" }),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedByDeviceId: uuid("resolved_by_device_id").references(() => companyDevices.id, { onDelete: "set null" }),
    responseNote: text("response_note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusCreatedIdx: index("device_file_requests_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    companyDeviceIdx: index("device_file_requests_company_device_idx").on(table.companyId, table.deviceId),
  }),
);
