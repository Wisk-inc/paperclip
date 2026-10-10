import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { StudioChangeFile, StudioMessageAttachment } from "@paperclipai/shared";
import { companies } from "./companies.js";

/**
 * A Studio project: a folder of code on the Automa server. Files live on disk
 * under the instance's studio directory; this row holds what the app lists.
 */
export const studioWorkspaces = pgTable(
  "studio_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    language: text("language").notNull(),
    description: text("description"),
    sourceUrl: text("source_url"),
    // Overrides the language's run command (cloned projects often need their own).
    runCommand: text("run_command"),
    createdByUserId: text("created_by_user_id"),
    // Collaborators join with this code while sharing is on.
    shareCode: text("share_code"),
    shareEnabled: boolean("share_enabled").notNull().default(false),
    shareExpiresAt: timestamp("share_expires_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("studio_workspaces_company_created_idx").on(table.companyId, table.createdAt),
    shareCodeUq: uniqueIndex("studio_workspaces_share_code_uq").on(table.shareCode),
  }),
);

/** Someone who joined a shared workspace with its code. Their token is stored hashed. */
export const studioCollaborators = pgTable(
  "studio_collaborators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => studioWorkspaces.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    color: text("color").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").$type<"active" | "removed">().notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("studio_collaborators_workspace_idx").on(table.workspaceId, table.createdAt),
    tokenHashUq: uniqueIndex("studio_collaborators_token_hash_uq").on(table.tokenHash),
  }),
);

/** Changes a collaborator proposed; they apply only when the owner accepts them. */
export const studioChangeRequests = pgTable(
  "studio_change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => studioWorkspaces.id, { onDelete: "cascade" }),
    collaboratorId: uuid("collaborator_id").references(() => studioCollaborators.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    message: text("message"),
    files: jsonb("files").$type<StudioChangeFile[]>().notNull(),
    status: text("status").$type<"open" | "accepted" | "rejected">().notNull().default("open"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("studio_change_requests_workspace_idx").on(table.workspaceId, table.createdAt),
  }),
);

/** The workspace's team chat: the owner and collaborators, with shared files. */
export const studioMessages = pgTable(
  "studio_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => studioWorkspaces.id, { onDelete: "cascade" }),
    authorType: text("author_type").$type<"owner" | "guest" | "system">().notNull(),
    authorName: text("author_name").notNull(),
    collaboratorId: uuid("collaborator_id").references(() => studioCollaborators.id, { onDelete: "set null" }),
    body: text("body").notNull().default(""),
    attachment: jsonb("attachment").$type<StudioMessageAttachment | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("studio_messages_workspace_idx").on(table.workspaceId, table.createdAt),
  }),
);

/**
 * A person's own AI API key for the Studio assistant, per provider, encrypted
 * with the instance's local secrets key. Never returned by the API.
 */
export const studioAiKeys = pgTable(
  "studio_ai_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    material: jsonb("material").$type<Record<string, unknown>>().notNull(),
    valueSha256: text("value_sha256").notNull(),
    last4: text("last4").notNull(),
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProviderUq: uniqueIndex("studio_ai_keys_company_user_provider_uq").on(table.companyId, table.userId, table.provider),
  }),
);
