import { createHash, randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { and, desc, eq, lt } from "drizzle-orm";
import { authUsers, studioAiKeys, studioChangeRequests, studioCollaborators, studioMessages, studioWorkspaces, type Db } from "@paperclipai/db";
import {
  STUDIO_AI_PROVIDERS,
  studioLanguage,
  type StudioAiKeyStatus,
  type StudioAiProvider,
  type StudioChangeFile,
  type StudioChangeRequest,
  type StudioCollaborator,
  type StudioMessage,
  type StudioMessageAttachment,
  type StudioWorkspace,
  type AiProvider,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../../errors.js";
import { localEncryptedProvider } from "../../secrets/local-encrypted-provider.js";
import { aiConnectionService } from "../ai-connections.js";
import { studioWorkspaceDirs, writeStarterFiles } from "./files.js";
import { studioChildEnv } from "./runner.js";
import { STUDIO_GUEST_COLORS } from "./hub.js";

type WorkspaceRow = typeof studioWorkspaces.$inferSelect;
type CollaboratorRow = typeof studioCollaborators.$inferSelect;
type ChangeRequestRow = typeof studioChangeRequests.$inferSelect;
type MessageRow = typeof studioMessages.$inferSelect;

const SHARE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function toStudioWorkspace(row: WorkspaceRow): StudioWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    language: row.language,
    description: row.description,
    sourceUrl: row.sourceUrl,
    runCommand: row.runCommand,
    createdByUserId: row.createdByUserId,
    shareCode: row.shareEnabled ? row.shareCode : null,
    shareEnabled: row.shareEnabled,
    shareExpiresAt: row.shareEnabled ? iso(row.shareExpiresAt) : null,
    lastRunAt: iso(row.lastRunAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCollaborator(row: CollaboratorRow): StudioCollaborator {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    displayName: row.displayName,
    color: row.color,
    status: row.status,
    lastSeenAt: iso(row.lastSeenAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toChangeRequest(row: ChangeRequestRow): StudioChangeRequest {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    collaboratorId: row.collaboratorId,
    authorName: row.authorName,
    message: row.message,
    files: row.files,
    status: row.status,
    resolvedAt: iso(row.resolvedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function toMessage(row: MessageRow): StudioMessage {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    authorType: row.authorType,
    authorName: row.authorName,
    collaboratorId: row.collaboratorId,
    body: row.body,
    attachment: row.attachment ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function newShareCode() {
  let code = "";
  for (let index = 0; index < 8; index += 1) code += SHARE_CODE_ALPHABET[randomInt(SHARE_CODE_ALPHABET.length)];
  return code;
}

/** Names nobody may join as: the system author and the owner's role. */
const RESERVED_GUEST_NAMES = ["automa", "owner", "system", "admin", "paperclip"];

/** One comparable form of a display name: trimmed, single-spaced, lower-cased, no control characters. */
export function comparableName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f\ufeff]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether a collaborator may not take `name`: it is reserved, or someone in
 * the project (the owner, an active collaborator) already goes by it. One
 * name, one person, so nobody can pose as another in the chat or a review.
 */
export function nameIsClaimed(name: string, taken: readonly (string | null | undefined)[]): boolean {
  const mine = comparableName(name);
  if (!mine || RESERVED_GUEST_NAMES.includes(mine)) return true;
  return taken.some((other) => other && comparableName(other) === mine);
}

/** Normalizes what someone typed as a code ("abcd 1234", "ABCD-1234") to the stored form. */
export function normalizeShareCode(input: string) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Only plain https/http Git URLs: no ssh, file, or ext:: transports. */
export function validateGitUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest("Paste a repository link like https://github.com/owner/repo");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("Use an https:// repository link");
  if (url.username || url.password) throw badRequest("Leave the user name and password out of the link");
  return url.toString().replace(/\/+$/, "");
}

/** Guesses the language of a cloned project from its files. */
export function detectStudioLanguage(files: readonly string[]): string {
  const has = (name: string) => files.includes(name);
  const any = (pattern: RegExp) => files.some((file) => pattern.test(file));
  if (has("package.json")) {
    if (any(/^vite\.config\./)) return "vite-react";
    return any(/\.tsx?$/) && !any(/\.jsx?$/) ? "typescript" : "javascript";
  }
  if (has("requirements.txt") || has("pyproject.toml") || any(/\.py$/)) return "python";
  if (has("go.mod") || any(/\.go$/)) return "go";
  if (has("Cargo.toml") || any(/\.rs$/)) return "rust";
  if (has("pom.xml") || any(/\.java$/)) return "java";
  if (any(/\.csproj$/)) return "csharp";
  if (has("Gemfile") || any(/\.rb$/)) return "ruby";
  if (has("composer.json") || any(/\.php$/)) return "php";
  if (any(/\.(kt|kts)$/)) return "kotlin";
  if (any(/\.swift$/)) return "swift";
  if (any(/\.dart$/)) return "dart";
  if (any(/\.(c|h)$/) && !any(/\.(cpp|cc|hpp)$/)) return "c";
  if (any(/\.(cpp|cc|hpp)$/)) return "cpp";
  if (has("index.html") || any(/\.html$/)) return "html";
  if (any(/\.sh$/)) return "bash";
  return "bash";
}

/** A sensible run command for a cloned project, from its files. */
export function suggestRunCommand(files: readonly string[], packageJson: { scripts?: Record<string, string> } | null): string | null {
  if (packageJson) {
    const scripts = packageJson.scripts ?? {};
    const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
    return script ? `npm install --no-audit --no-fund && npm run ${script}` : "npm install --no-audit --no-fund && node .";
  }
  if (files.includes("Cargo.toml")) return "cargo run";
  if (files.includes("go.mod")) return "go run .";
  if (files.includes("requirements.txt")) {
    const main = ["main.py", "app.py", "manage.py"].find((file) => files.includes(file));
    return main ? `python3 -m pip install -q -r requirements.txt && python3 ${main}${main === "manage.py" ? " runserver 127.0.0.1:$PORT" : ""}` : null;
  }
  if (files.includes("pom.xml")) return "mvn -q compile exec:java";
  if (files.includes("Gemfile")) return "bundle install && ruby main.rb";
  return null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isShareExpired(row: { shareExpiresAt: Date | null }) {
  return row.shareExpiresAt !== null && row.shareExpiresAt.getTime() <= Date.now();
}

export function studioService(db: Db) {
  async function get(id: string) {
    if (!UUID_PATTERN.test(id)) return null;
    const [row] = await db.select().from(studioWorkspaces).where(eq(studioWorkspaces.id, id)).limit(1);
    return row && !row.archivedAt ? row : null;
  }

  async function require(id: string) {
    const row = await get(id);
    if (!row) throw notFound("Studio project not found");
    return row;
  }

  async function list(companyId: string) {
    const rows = await db
      .select()
      .from(studioWorkspaces)
      .where(eq(studioWorkspaces.companyId, companyId))
      .orderBy(desc(studioWorkspaces.updatedAt));
    return rows.filter((row) => !row.archivedAt).map(toStudioWorkspace);
  }

  async function cloneRepository(url: string, target: string, log: (line: string) => void) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    log(`$ git clone --depth 1 ${url}`);
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn("git", ["clone", "--depth", "1", "--", url, target], {
        env: studioChildEnv({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const collect = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        output += text;
        for (const line of text.split(/[\r\n]+/)) if (line.trim()) log(line.trim());
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: -1, output: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
    if (result.code !== 0) {
      await fs.rm(target, { recursive: true, force: true });
      const missingGit = /ENOENT/.test(result.output);
      throw unprocessable(
        missingGit
          ? "Git is not installed on this device (in Termux: pkg install git)."
          : `Cloning failed: ${result.output.trim().split("\n").slice(-2).join(" ") || "unknown error"}`,
      );
    }
  }

  async function create(input: {
    companyId: string;
    userId: string | null;
    name: string;
    language: string;
    description?: string | null;
    gitUrl?: string | null;
    log?: (line: string) => void;
  }) {
    const log = input.log ?? (() => undefined);
    const gitUrl = input.gitUrl ? validateGitUrl(input.gitUrl) : null;
    const language = studioLanguage(input.language);
    if (!gitUrl && !language) throw badRequest("Pick a language");
    const [row] = await db
      .insert(studioWorkspaces)
      .values({
        companyId: input.companyId,
        name: input.name.trim(),
        language: language?.id ?? "auto",
        description: input.description?.trim() || null,
        sourceUrl: gitUrl,
        createdByUserId: input.userId,
      })
      .returning();
    const dirs = studioWorkspaceDirs(row!.companyId, row!.id);
    try {
      await fs.mkdir(dirs.meta, { recursive: true });
      if (gitUrl) {
        await cloneRepository(gitUrl, dirs.files, log);
        const files = await fs.readdir(dirs.files);
        let packageJson: { scripts?: Record<string, string> } | null = null;
        if (files.includes("package.json")) {
          packageJson = JSON.parse(await fs.readFile(path.join(dirs.files, "package.json"), "utf8").catch(() => "{}"));
        }
        const detected = language?.id && input.language !== "auto" ? language.id : detectStudioLanguage(files);
        const runCommand = suggestRunCommand(files, packageJson);
        const [updated] = await db
          .update(studioWorkspaces)
          .set({ language: detected, runCommand, updatedAt: new Date() })
          .where(eq(studioWorkspaces.id, row!.id))
          .returning();
        return toStudioWorkspace(updated!);
      }
      await fs.mkdir(dirs.files, { recursive: true });
      await writeStarterFiles(dirs.files, language!.files);
      return toStudioWorkspace(row!);
    } catch (error) {
      await db.delete(studioWorkspaces).where(eq(studioWorkspaces.id, row!.id));
      await fs.rm(dirs.base, { recursive: true, force: true });
      throw error;
    }
  }

  async function update(id: string, patch: { name?: string; description?: string | null; runCommand?: string | null }) {
    const values: Partial<typeof studioWorkspaces.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name.trim();
    if (patch.description !== undefined) values.description = patch.description?.trim() || null;
    if (patch.runCommand !== undefined) values.runCommand = patch.runCommand?.trim() || null;
    const [row] = await db.update(studioWorkspaces).set(values).where(eq(studioWorkspaces.id, id)).returning();
    if (!row) throw notFound("Studio project not found");
    return toStudioWorkspace(row);
  }

  async function touch(id: string, ran = false) {
    await db
      .update(studioWorkspaces)
      .set(ran ? { lastRunAt: new Date(), updatedAt: new Date() } : { updatedAt: new Date() })
      .where(eq(studioWorkspaces.id, id));
  }

  async function remove(id: string) {
    const row = await require(id);
    await db.delete(studioWorkspaces).where(eq(studioWorkspaces.id, id));
    const dirs = studioWorkspaceDirs(row.companyId, row.id);
    if (existsSync(dirs.base)) await fs.rm(dirs.base, { recursive: true, force: true });
    return row;
  }

  /**
   * Turns sharing on (or updates it): keeps the current code unless a new
   * one is asked for, and sets when the code stops working. `expiresInHours`
   * left out keeps the current expiry; null means no expiry.
   */
  async function enableShare(id: string, options: { expiresInHours?: number | null; newCode?: boolean } = {}) {
    const row = await require(id);
    const shareExpiresAt =
      options.expiresInHours === undefined
        ? row.shareEnabled && !isShareExpired(row)
          ? row.shareExpiresAt
          : null
        : options.expiresInHours === null
          ? null
          : new Date(Date.now() + options.expiresInHours * 3_600_000);
    const keepCode = row.shareEnabled && row.shareCode && !options.newCode && !isShareExpired(row);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const [updated] = await db
          .update(studioWorkspaces)
          .set({ shareEnabled: true, shareCode: keepCode ? row.shareCode : newShareCode(), shareExpiresAt, updatedAt: new Date() })
          .where(eq(studioWorkspaces.id, id))
          .returning();
        return toStudioWorkspace(updated!);
      } catch (error) {
        if (attempt === 5) throw error;
      }
    }
    throw conflict("Could not make a share code; try again");
  }

  async function disableShare(id: string) {
    await require(id);
    const [updated] = await db
      .update(studioWorkspaces)
      .set({ shareEnabled: false, shareCode: null, shareExpiresAt: null, updatedAt: new Date() })
      .where(eq(studioWorkspaces.id, id))
      .returning();
    await db
      .update(studioCollaborators)
      .set({ status: "removed" })
      .where(and(eq(studioCollaborators.workspaceId, id), eq(studioCollaborators.status, "active")));
    return toStudioWorkspace(updated!);
  }

  async function join(code: string, name: string) {
    const normalized = normalizeShareCode(code);
    if (normalized.length < 6) throw badRequest("Check the code and try again");
    const [workspace] = await db.select().from(studioWorkspaces).where(eq(studioWorkspaces.shareCode, normalized)).limit(1);
    if (!workspace || !workspace.shareEnabled || workspace.archivedAt) throw notFound("No shared project has that code (or sharing was turned off)");
    if (isShareExpired(workspace)) throw notFound("This code has expired. Ask for a new one.");
    const existing = await db
      .select({ id: studioCollaborators.id, displayName: studioCollaborators.displayName, status: studioCollaborators.status })
      .from(studioCollaborators)
      .where(eq(studioCollaborators.workspaceId, workspace.id));
    const owner = workspace.createdByUserId
      ? await db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, workspace.createdByUserId)).then((rows) => rows[0] ?? null)
      : null;
    const cleanName = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
    if (!cleanName) throw badRequest("Enter a name");
    const taken = [owner?.name, ...existing.filter((row) => row.status === "active").map((row) => row.displayName)];
    if (nameIsClaimed(cleanName, taken)) throw conflict("That name is already taken in this project. Pick another one.");
    const token = randomBytes(24).toString("base64url");
    const [collaborator] = await db
      .insert(studioCollaborators)
      .values({
        companyId: workspace.companyId,
        workspaceId: workspace.id,
        displayName: cleanName,
        color: STUDIO_GUEST_COLORS[existing.length % STUDIO_GUEST_COLORS.length]!,
        tokenHash: hashToken(token),
      })
      .returning();
    return { token, collaborator: toCollaborator(collaborator!), workspace };
  }

  /** The collaborator and project for a guest token, while both are still active. */
  async function guestByToken(token: string | null | undefined) {
    if (!token || token.length < 16) return null;
    const [collaborator] = await db
      .select()
      .from(studioCollaborators)
      .where(eq(studioCollaborators.tokenHash, hashToken(token)))
      .limit(1);
    if (!collaborator || collaborator.status !== "active") return null;
    const workspace = await get(collaborator.workspaceId);
    if (!workspace || !workspace.shareEnabled || isShareExpired(workspace)) return null;
    await db.update(studioCollaborators).set({ lastSeenAt: new Date() }).where(eq(studioCollaborators.id, collaborator.id));
    return { collaborator, workspace };
  }

  /** Turns sharing off for every project whose code has expired; returns their ids. */
  async function expireShares(): Promise<string[]> {
    const expired = await db
      .select({ id: studioWorkspaces.id })
      .from(studioWorkspaces)
      .where(and(eq(studioWorkspaces.shareEnabled, true), lt(studioWorkspaces.shareExpiresAt, new Date())));
    for (const row of expired) await disableShare(row.id);
    return expired.map((row) => row.id);
  }

  async function collaborators(workspaceId: string) {
    const rows = await db
      .select()
      .from(studioCollaborators)
      .where(eq(studioCollaborators.workspaceId, workspaceId))
      .orderBy(desc(studioCollaborators.createdAt));
    return rows.map(toCollaborator);
  }

  async function removeCollaborator(workspaceId: string, collaboratorId: string) {
    if (!UUID_PATTERN.test(collaboratorId)) throw notFound("Collaborator not found");
    const [row] = await db
      .update(studioCollaborators)
      .set({ status: "removed" })
      .where(and(eq(studioCollaborators.workspaceId, workspaceId), eq(studioCollaborators.id, collaboratorId)))
      .returning();
    if (!row) throw notFound("Collaborator not found");
    return toCollaborator(row);
  }

  async function messages(workspaceId: string, limit = 200) {
    const rows = await db
      .select()
      .from(studioMessages)
      .where(eq(studioMessages.workspaceId, workspaceId))
      .orderBy(desc(studioMessages.createdAt))
      .limit(limit);
    return rows.reverse().map(toMessage);
  }

  async function postMessage(input: {
    workspace: WorkspaceRow;
    authorType: "owner" | "guest" | "system";
    authorName: string;
    collaboratorId?: string | null;
    body: string;
    attachment?: StudioMessageAttachment | null;
  }) {
    if (!input.body.trim() && !input.attachment) throw badRequest("Write a message or attach a file");
    const [row] = await db
      .insert(studioMessages)
      .values({
        companyId: input.workspace.companyId,
        workspaceId: input.workspace.id,
        authorType: input.authorType,
        authorName: input.authorName,
        collaboratorId: input.collaboratorId ?? null,
        body: input.body.trim(),
        attachment: input.attachment ?? null,
      })
      .returning();
    return toMessage(row!);
  }

  async function changeRequests(workspaceId: string) {
    const rows = await db
      .select()
      .from(studioChangeRequests)
      .where(eq(studioChangeRequests.workspaceId, workspaceId))
      .orderBy(desc(studioChangeRequests.createdAt))
      .limit(100);
    return rows.map(toChangeRequest);
  }

  async function getChangeRequest(workspaceId: string, id: string) {
    if (!UUID_PATTERN.test(id)) throw notFound("Change request not found");
    const [row] = await db
      .select()
      .from(studioChangeRequests)
      .where(and(eq(studioChangeRequests.workspaceId, workspaceId), eq(studioChangeRequests.id, id)))
      .limit(1);
    if (!row) throw notFound("Change request not found");
    return row;
  }

  async function createChangeRequest(input: {
    workspace: WorkspaceRow;
    collaboratorId: string | null;
    authorName: string;
    message?: string | null;
    files: StudioChangeFile[];
  }) {
    const [row] = await db
      .insert(studioChangeRequests)
      .values({
        companyId: input.workspace.companyId,
        workspaceId: input.workspace.id,
        collaboratorId: input.collaboratorId,
        authorName: input.authorName,
        message: input.message?.trim() || null,
        files: input.files,
      })
      .returning();
    return toChangeRequest(row!);
  }

  async function resolveChangeRequest(workspaceId: string, id: string, status: "accepted" | "rejected", userId: string | null, files?: StudioChangeFile[]) {
    const row = await getChangeRequest(workspaceId, id);
    if (row.status !== "open") throw conflict("This change request was already handled");
    const [updated] = await db
      .update(studioChangeRequests)
      .set({ status, resolvedAt: new Date(), resolvedByUserId: userId, ...(files ? { files } : {}) })
      .where(eq(studioChangeRequests.id, id))
      .returning();
    return toChangeRequest(updated!);
  }

  /** Studio providers that the organization's API keys page can also supply. */
  const ORGANIZATION_KEY_PROVIDERS: Partial<Record<StudioAiProvider, AiProvider>> = {
    anthropic: "anthropic",
    openai: "openai",
    openrouter: "openrouter",
    xai: "xai",
  };

  async function aiKeyStatuses(companyId: string, userId: string): Promise<StudioAiKeyStatus[]> {
    const [rows, organizationKeys] = await Promise.all([
      db
        .select()
        .from(studioAiKeys)
        .where(and(eq(studioAiKeys.companyId, companyId), eq(studioAiKeys.userId, userId))),
      aiConnectionService(db).list(companyId, userId).catch(() => []),
    ]);
    return STUDIO_AI_PROVIDERS.map((provider) => {
      const row = rows.find((item) => item.provider === provider);
      const organizationProvider = ORGANIZATION_KEY_PROVIDERS[provider];
      const shared = organizationProvider
        ? organizationKeys.find((key) => key.provider === organizationProvider && key.method === "api_key" && key.status === "connected")
        : undefined;
      return {
        provider,
        connected: Boolean(row) || Boolean(shared),
        last4: row?.last4 ?? null,
        baseUrl: row?.baseUrl ?? null,
        updatedAt: row ? row.updatedAt.toISOString() : null,
        source: row ? "studio" : shared ? "automa" : null,
      };
    });
  }

  async function saveAiKey(companyId: string, userId: string, provider: StudioAiProvider, apiKey: string, baseUrl: string | null) {
    if (provider === "custom" && !baseUrl) throw badRequest("Add the API's base URL (for example https://host/v1)");
    const prepared = await localEncryptedProvider.createSecret({ value: apiKey });
    const values = {
      companyId,
      userId,
      provider,
      material: prepared.material as Record<string, unknown>,
      valueSha256: prepared.valueSha256,
      last4: apiKey.slice(-4),
      baseUrl: baseUrl?.replace(/\/+$/, "") || null,
      updatedAt: new Date(),
    };
    await db
      .insert(studioAiKeys)
      .values(values)
      .onConflictDoUpdate({ target: [studioAiKeys.companyId, studioAiKeys.userId, studioAiKeys.provider], set: values });
    return (await aiKeyStatuses(companyId, userId)).find((status) => status.provider === provider)!;
  }

  async function deleteAiKey(companyId: string, userId: string, provider: StudioAiProvider) {
    await db
      .delete(studioAiKeys)
      .where(and(eq(studioAiKeys.companyId, companyId), eq(studioAiKeys.userId, userId), eq(studioAiKeys.provider, provider)));
  }

  async function resolveAiKey(companyId: string, userId: string, provider: StudioAiProvider) {
    const [row] = await db
      .select()
      .from(studioAiKeys)
      .where(and(eq(studioAiKeys.companyId, companyId), eq(studioAiKeys.userId, userId), eq(studioAiKeys.provider, provider)))
      .limit(1);
    if (!row) {
      // No Studio key: the organization's key for this provider (Settings → API keys).
      const organizationProvider = ORGANIZATION_KEY_PROVIDERS[provider];
      if (!organizationProvider) return null;
      const apiKey = await aiConnectionService(db).credentialForProvider(companyId, userId, organizationProvider).catch(() => null);
      return apiKey ? { apiKey, baseUrl: null } : null;
    }
    const apiKey = await localEncryptedProvider.resolveVersion({ material: row.material as never, externalRef: null });
    return { apiKey, baseUrl: row.baseUrl };
  }

  return {
    get,
    require,
    list,
    create,
    update,
    touch,
    remove,
    enableShare,
    disableShare,
    join,
    guestByToken,
    expireShares,
    collaborators,
    removeCollaborator,
    messages,
    postMessage,
    changeRequests,
    getChangeRequest,
    createChangeRequest,
    resolveChangeRequest,
    aiKeyStatuses,
    saveAiKey,
    deleteAiKey,
    resolveAiKey,
  };
}

export type StudioService = ReturnType<typeof studioService>;
