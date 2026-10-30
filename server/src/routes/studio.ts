import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { Router, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import { authUsers, type Db, type studioWorkspaces } from "@paperclipai/db";
import {
  STUDIO_LANGUAGES,
  STUDIO_LANGUAGE_CATEGORIES,
  createStudioChangeRequestSchema,
  createStudioCheckpointSchema,
  shareStudioSchema,
  studioCompleteSchema,
  STUDIO_AI_PROVIDER_INFO,
  createStudioEntrySchema,
  createStudioWorkspaceSchema,
  execStudioCommandSchema,
  joinStudioSchema,
  moveStudioEntrySchema,
  postStudioMessageSchema,
  resolveStudioChangeRequestSchema,
  saveStudioAiKeySchema,
  studioAssistantMessageSchema,
  studioConsoleInputSchema,
  studioLanguage,
  studioRunSchema,
  updateStudioWorkspaceSchema,
  writeStudioFileSchema,
  STUDIO_AI_PROVIDERS,
  type StudioAiProvider,
  type StudioChangeFile,
  type StudioMessageAttachment,
  type StudioParticipant,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { badRequest, conflict, notFound, tooManyRequests, unauthorized, unprocessable } from "../errors.js";
import { budgetService, heartbeatService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import {
  createStudioEntry,
  deleteStudioEntry,
  listTree,
  moveStudioEntry,
  normalizeStudioPath,
  readStudioFile,
  resolveInside,
  saveUploadedFile,
  saveUploadedTempFile,
  studioWorkspaceDirs,
  writeStudioFile,
} from "../services/studio/files.js";
import { studioService } from "../services/studio/service.js";
import { studioModelUsage, studioUsageRecorder } from "../services/studio/usage.js";
import { disposeStudioRuntime, existingStudioRuntime, stopAllStudioRuntimes, studioRuntime, studioRuntimeByPreviewToken } from "../services/studio/runner.js";
import { allToolchainStatuses, toolchainStatus, studioHostPlatform, installCommandFor, installExecCommandFor, clearToolchainCache } from "../services/studio/toolchains.js";
import { cloudflaredPath, installCloudflared, openQuickTunnel } from "../services/studio/tunnel.js";
import { STUDIO_OWNER_COLOR, studioHub } from "../services/studio/hub.js";
import { StudioGateway } from "../services/studio/gateway.js";
import { AttemptLimiter, joinLimiterKey } from "../services/studio/join-limiter.js";
import { createCheckpoint, deleteCheckpoint, listCheckpoints, restoreCheckpoint, streamProjectZip } from "../services/studio/checkpoints.js";
import { undoEdit } from "../services/studio/edits.js";
import {
  clearAssistantConversation,
  completeCode,
  currentAssistantTurn,
  isAssistantRunning,
  markEditUndone,
  readAssistantTranscript,
  runAssistantTurn,
  stopAssistant,
} from "../services/studio/assistant.js";

type WorkspaceRow = typeof studioWorkspaces.$inferSelect;

/** Ten wrong share codes per client, or forty overall, in ten minutes. */
const joinLimiter = new AttemptLimiter({ windowMs: 10 * 60_000, perKey: 10, total: 40 });

// Project uploads stream to temporary files instead of memory: thirty 50 MB
// files at once were held in the server's memory, which a phone can't spare.
// Browsers send file names as UTF-8.
const upload = multer({ dest: os.tmpdir(), defParamCharset: "utf8", limits: { fileSize: 50 * 1024 * 1024, files: 30 } });
const attachmentUpload = multer({ storage: multer.memoryStorage(), defParamCharset: "utf8", limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

/** Reads a multipart body only once the caller is known: multer stores the files before the handler runs. */
function readMultipart(parse: RequestHandler, req: Request, res: Response) {
  return new Promise<void>((resolve, reject) => {
    parse(req, res, (error?: unknown) => (error ? reject(error) : resolve()));
  });
}

/** One gateway for collaborators per server, and its public link. */
const gateway = new StudioGateway(() => Number(process.env.PAPERCLIP_LISTEN_PORT || 3100));
let gatewayTunnel: { url: string; process: import("node:child_process").ChildProcess } | null = null;
let gatewayTunnelPending: Promise<string> | null = null;

async function ensureGatewayPublicUrl(): Promise<string> {
  if (gatewayTunnel) return gatewayTunnel.url;
  if (gatewayTunnelPending) return gatewayTunnelPending;
  gatewayTunnelPending = (async () => {
    const port = await gateway.start();
    const tunnel = await openQuickTunnel(port, () => {
      gatewayTunnel = null;
    });
    gatewayTunnel = tunnel;
    return tunnel.url;
  })();
  try {
    return await gatewayTunnelPending;
  } finally {
    gatewayTunnelPending = null;
  }
}

process.once("exit", () => {
  try {
    gatewayTunnel?.process.kill("SIGTERM");
  } catch {
    // already gone
  }
});

/** Stops every running Studio app, public link, and the collaborator gateway. */
export async function shutdownStudio() {
  if (expirySweep) clearInterval(expirySweep);
  expirySweep = null;
  gatewayTunnel?.process.kill("SIGTERM");
  gatewayTunnel = null;
  await Promise.all([gateway.stop(), stopAllStudioRuntimes()]);
}

function languageCatalog() {
  return STUDIO_LANGUAGES.map(({ files, ...language }) => ({ ...language, starterFiles: Object.keys(files) }));
}

function runCommandFor(workspace: WorkspaceRow): { command: string; static: boolean } {
  if (workspace.runCommand?.trim()) return { command: workspace.runCommand.trim(), static: false };
  const language = studioLanguage(workspace.language);
  if (!language || language.kind === "static" || !language.run) return { command: "", static: true };
  return { command: language.run, static: false };
}

async function startApp(workspace: WorkspaceRow) {
  const dirs = studioWorkspaceDirs(workspace.companyId, workspace.id);
  const runtime = studioRuntime(workspace.id);
  const run = runCommandFor(workspace);
  if (run.static) await runtime.startStatic(dirs.files);
  else await runtime.start(dirs.files, run.command);
}

async function broadcastFile(workspace: WorkspaceRow, relative: string, by: string) {
  const dirs = studioWorkspaceDirs(workspace.companyId, workspace.id);
  const file = await readStudioFile(dirs.files, relative).catch(() => null);
  studioHub.broadcast(workspace.id, {
    type: "file:saved",
    path: normalizeStudioPath(relative),
    version: file?.version ?? "deleted",
    content: file && file.content !== null && file.content.length < 500_000 ? file.content : null,
    by,
  });
  studioHub.broadcast(workspace.id, { type: "tree:changed" });
}

function sendDownload(res: Response, absolute: string, name: string) {
  // Header values must be Latin-1: the real name (emoji, accents) goes in filename*.
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader("content-disposition", `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encoded}`);
  res.setHeader("content-type", "application/octet-stream");
  res.setHeader("x-content-type-options", "nosniff");
  createReadStream(absolute).on("error", () => res.status(404).end()).pipe(res);
}

async function saveAttachment(workspace: WorkspaceRow, file: Express.Multer.File): Promise<StudioMessageAttachment> {
  const id = randomUUID();
  const dirs = studioWorkspaceDirs(workspace.companyId, workspace.id);
  const dir = path.join(dirs.meta, "shared", id);
  await fs.mkdir(dir, { recursive: true });
  // At most 200 bytes: a file name may have 255, and one character can take four.
  const cut = Buffer.from(path.basename(file.originalname || "file").replace(/[\0/\\]/g, "_")).subarray(0, 200).toString("utf8");
  const name = cut.replace(/\uFFFD+$/, "") || "file";
  await fs.writeFile(path.join(dir, name), file.buffer);
  return { id, name, size: file.size, contentType: file.mimetype || null };
}

async function attachmentPath(workspace: WorkspaceRow, attachmentId: string) {
  if (!/^[0-9a-f-]{36}$/.test(attachmentId)) throw notFound("File not found");
  const dir = path.join(studioWorkspaceDirs(workspace.companyId, workspace.id).meta, "shared", attachmentId);
  const [name] = await fs.readdir(dir).catch(() => [] as string[]);
  if (!name) throw notFound("File not found");
  return { absolute: path.join(dir, name), name };
}

const RAW_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  ico: "image/x-icon", svg: "image/svg+xml", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp4: "video/mp4",
  webm: "video/webm", mov: "video/quicktime", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", pdf: "application/pdf",
};

/** Sends a project file to view inline (images, audio, fonts), sandboxed. */
async function sendRaw(res: Response, root: string, relative: string) {
  const absolute = await resolveInside(root, relative);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) throw notFound("File not found");
  const ext = path.extname(absolute).slice(1).toLowerCase();
  res.setHeader("content-type", RAW_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "private, max-age=10");
  createReadStream(absolute).on("error", () => res.status(404).end()).pipe(res);
}

/** Streams a zip of the project (or a folder in it). */
async function sendZip(res: Response, root: string, relative: string, fallbackName: string) {
  const name = `${(relative ? path.basename(relative) : fallbackName).replace(/[^\w .-]+/g, "_").trim() || "project"}.zip`;
  res.setHeader("content-type", "application/zip");
  res.setHeader("content-disposition", `attachment; filename="${name}"`);
  res.setHeader("x-content-type-options", "nosniff");
  await streamProjectZip(root, relative, (chunk) =>
    new Promise<void>((resolve) => {
      if (res.write(Buffer.from(chunk))) resolve();
      else res.once("drain", () => resolve());
    }),
  );
  res.end();
}

/**
 * Applies proposed file changes to the project. Each `after` replaces the
 * file; a null `after` deletes it.
 */
async function applyChangeFiles(workspace: WorkspaceRow, files: StudioChangeFile[]) {
  const dirs = studioWorkspaceDirs(workspace.companyId, workspace.id);
  for (const file of files) {
    if (file.after === null) await deleteStudioEntry(dirs.files, file.path);
    else await writeStudioFile(dirs.files, file.path, file.after);
  }
}

let expirySweep: ReturnType<typeof setInterval> | null = null;

/** Owner routes: board users with access to the project's company. */
export function studioRoutes(db: Db) {
  const heartbeat = heartbeatService(db);
  const budgetHooks = { cancelWorkForScope: heartbeat.cancelBudgetScopeWork };
  const budgets = budgetService(db, budgetHooks);
  // Studio spend counts toward the budget like an agent's, and crossing the
  // hard-stop stops agent work the same way.
  const studioUsage = studioUsageRecorder(db, budgetHooks);
  const startingAssistant = new Set<string>();

  async function assertStudioAiAllowed(companyId: string) {
    const block = await budgets.getCompanyInvocationBlock(companyId);
    if (block) throw conflict(block.reason, { code: "budget_blocked", budgetBlock: block });
  }
  const router = Router();
  const svc = studioService(db);

  // Codes with an expiry stop working on time: guests are let go and sharing turns off.
  if (!expirySweep) {
    expirySweep = setInterval(() => {
      void svc
        .expireShares()
        .then((ids) => {
          for (const id of ids) {
            studioHub.kickGuests(id, "The share code expired.");
            studioHub.broadcast(id, { type: "share", shareEnabled: false });
          }
        })
        .catch(() => undefined);
    }, 30_000);
    expirySweep.unref?.();
  }

  async function ownerName(userId: string | null | undefined) {
    if (!userId || userId === "local-board") return "Owner";
    const [row] = await db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, userId)).limit(1);
    return row?.name?.trim() || "Owner";
  }

  async function workspaceFor(req: Request) {
    assertBoard(req);
    const workspace = await svc.get(String(req.params.id));
    // Missing and other-company apps answer the same 404, so ids can't be probed.
    if (!workspace || !hasCompanyAccess(req, workspace.companyId)) throw notFound("Studio project not found");
    assertCompanyAccess(req, workspace.companyId);
    return workspace;
  }

  function actor(req: Request) {
    return req.actor.userId ?? "board";
  }

  const lastFileSaveLog = new Map<string, number>();
  function shouldLogFileSave(workspaceId: string, filePath: string) {
    const key = `${workspaceId}:${filePath}`;
    const now = Date.now();
    if (now - (lastFileSaveLog.get(key) ?? 0) < 10 * 60_000) return false;
    lastFileSaveLog.set(key, now);
    if (lastFileSaveLog.size > 5_000) lastFileSaveLog.clear();
    return true;
  }

  async function log(req: Request, workspace: WorkspaceRow, action: string, details: Record<string, unknown> = {}) {
    await logActivity(db, {
      companyId: workspace.companyId,
      actorType: "user",
      actorId: actor(req),
      action,
      entityType: "studio_workspace",
      entityId: workspace.id,
      details: { name: workspace.name, ...details },
    });
  }

  function runPayload(workspace: WorkspaceRow) {
    const runtime = existingStudioRuntime(workspace.id);
    return runtime?.state ?? studioRuntime(workspace.id).state;
  }

  router.get("/companies/:companyId/studio/languages", async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, String(req.params.companyId));
    if (req.query.refresh === "1") clearToolchainCache();
    res.json({
      platform: studioHostPlatform(),
      categories: STUDIO_LANGUAGE_CATEGORIES,
      languages: languageCatalog(),
      toolchains: allToolchainStatuses(),
      cloudflared: Boolean(cloudflaredPath()),
    });
  });

  router.get("/companies/:companyId/studio/workspaces", async (req, res) => {
    assertBoard(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const workspaces = await svc.list(companyId);
    res.json({
      workspaces: workspaces.map((workspace) => ({ ...workspace, run: existingStudioRuntime(workspace.id)?.state ?? null })),
    });
  });

  router.post("/companies/:companyId/studio/workspaces", validate(createStudioWorkspaceSchema), async (req, res) => {
    assertBoard(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const log: string[] = [];
    const workspace = await svc.create({
      companyId,
      userId: req.actor.userId ?? null,
      name: req.body.name,
      language: req.body.language,
      description: req.body.description,
      gitUrl: req.body.gitUrl,
      log: (line) => log.push(line),
    });
    const runtime = studioRuntime(workspace.id);
    for (const line of log) runtime.append("system", line);
    runtime.append("system", workspace.sourceUrl ? `Cloned ${workspace.sourceUrl}.` : `Created ${workspace.name}. Tap Run to start it.`);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor(req),
      action: "studio.workspace_created",
      entityType: "studio_workspace",
      entityId: workspace.id,
      details: { name: workspace.name, language: workspace.language, cloned: Boolean(workspace.sourceUrl) },
    });
    res.status(201).json({ workspace, toolchain: studioLanguage(workspace.language) ? toolchainStatus(studioLanguage(workspace.language)!) : null });
  });

  router.get("/studio/workspaces/:id", async (req, res) => {
    const workspace = await workspaceFor(req);
    const language = studioLanguage(workspace.language);
    res.json({
      workspace: (await svc.list(workspace.companyId)).find((item) => item.id === workspace.id) ?? null,
      run: runPayload(workspace),
      runCommand: runCommandFor(workspace).command || null,
      toolchain: language ? toolchainStatus(language) : null,
      participants: studioHub.participants(workspace.id),
      assistantRunning: isAssistantRunning(workspace.id),
    });
  });

  router.patch("/studio/workspaces/:id", validate(updateStudioWorkspaceSchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    const updated = await svc.update(workspace.id, req.body);
    await log(req, workspace, "studio.workspace_updated", { fields: Object.keys(req.body ?? {}) });
    res.json({ workspace: updated });
  });

  router.delete("/studio/workspaces/:id", async (req, res) => {
    const workspace = await workspaceFor(req);
    studioHub.kickGuests(workspace.id, "The owner deleted this project.");
    // The assistant stops first and gets a moment to wind down, or its last
    // save recreated the deleted folder (and its tools kept running).
    stopAssistant(workspace.id);
    for (let waited = 0; isAssistantRunning(workspace.id) && waited < 5_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await disposeStudioRuntime(workspace.id);
    await svc.remove(workspace.id);
    await log(req, workspace, "studio.workspace_deleted");
    res.json({ ok: true });
  });

  // ── Files ────────────────────────────────────────────────────────────────

  router.get("/studio/workspaces/:id/tree", async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ tree: await listTree(studioWorkspaceDirs(workspace.companyId, workspace.id).files) });
  });

  router.get("/studio/workspaces/:id/file", async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json(await readStudioFile(studioWorkspaceDirs(workspace.companyId, workspace.id).files, String(req.query.path ?? "")));
  });

  router.put("/studio/workspaces/:id/file", validate(writeStudioFileSchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    const dirs = studioWorkspaceDirs(workspace.companyId, workspace.id);
    const file = await writeStudioFile(dirs.files, req.body.path, req.body.content, req.body.baseVersion);
    await svc.touch(workspace.id);
    studioHub.broadcast(workspace.id, { type: "file:saved", path: file.path, version: file.version, content: file.content, by: actor(req) });
    // The editor saves as you type; the log gets one line per file per few minutes.
    if (shouldLogFileSave(workspace.id, file.path)) await log(req, workspace, "studio.file_saved", { path: file.path });
    res.json(file);
  });

  router.post("/studio/workspaces/:id/entries", validate(createStudioEntrySchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    await createStudioEntry(studioWorkspaceDirs(workspace.companyId, workspace.id).files, req.body.path, req.body.type);
    studioHub.broadcast(workspace.id, { type: "tree:changed" });
    await log(req, workspace, "studio.entry_created", { path: normalizeStudioPath(req.body.path), entryType: req.body.type });
    res.status(201).json({ ok: true, path: normalizeStudioPath(req.body.path) });
  });

  router.post("/studio/workspaces/:id/move", validate(moveStudioEntrySchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    await moveStudioEntry(studioWorkspaceDirs(workspace.companyId, workspace.id).files, req.body.from, req.body.to);
    studioHub.broadcast(workspace.id, { type: "tree:changed" });
    await log(req, workspace, "studio.entry_moved", { from: req.body.from, to: req.body.to });
    res.json({ ok: true });
  });

  router.delete("/studio/workspaces/:id/entries", async (req, res) => {
    const workspace = await workspaceFor(req);
    const relative = String(req.query.path ?? "");
    await deleteStudioEntry(studioWorkspaceDirs(workspace.companyId, workspace.id).files, relative);
    studioHub.broadcast(workspace.id, { type: "tree:changed" });
    await log(req, workspace, "studio.entry_deleted", { path: relative });
    res.json({ ok: true });
  });

  router.post("/studio/workspaces/:id/upload", async (req, res) => {
    const workspace = await workspaceFor(req);
    await readMultipart(upload.array("files", 30), req, res);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      if (files.length === 0) throw badRequest("Choose at least one file");
      const folder = typeof req.body?.folder === "string" && req.body.folder.trim() ? req.body.folder.trim() : null;
      const saved: string[] = [];
      const root = studioWorkspaceDirs(workspace.companyId, workspace.id).files;
      for (const file of files) saved.push(await saveUploadedTempFile(root, folder, file.originalname, file.path));
      studioHub.broadcast(workspace.id, { type: "tree:changed" });
      await log(req, workspace, "studio.files_uploaded", { paths: saved });
      res.status(201).json({ paths: saved });
    } finally {
      // Whatever wasn't moved into the project (an error part-way) is removed.
      await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => undefined)));
    }
  });

  router.get("/studio/workspaces/:id/archive", async (req, res) => {
    const workspace = await workspaceFor(req);
    const relative = typeof req.query.path === "string" && req.query.path.trim() ? normalizeStudioPath(req.query.path) : "";
    await sendZip(res, studioWorkspaceDirs(workspace.companyId, workspace.id).files, relative, workspace.name);
  });

  router.get("/studio/workspaces/:id/raw", async (req, res) => {
    const workspace = await workspaceFor(req);
    await sendRaw(res, studioWorkspaceDirs(workspace.companyId, workspace.id).files, String(req.query.path ?? ""));
  });

  // ── Checkpoints ──────────────────────────────────────────────────────────

  router.get("/studio/workspaces/:id/checkpoints", async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ checkpoints: await listCheckpoints(workspace.companyId, workspace.id) });
  });

  router.post("/studio/workspaces/:id/checkpoints", validate(createStudioCheckpointSchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    const checkpoint = await createCheckpoint(workspace.companyId, workspace.id, {
      label: req.body.label?.trim() || `Saved ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
      kind: "manual",
      by: await ownerName(req.actor.userId),
    });
    await log(req, workspace, "studio.checkpoint_saved", { checkpointId: checkpoint.id });
    res.status(201).json({ checkpoint });
  });

  router.post("/studio/workspaces/:id/checkpoints/:checkpointId/restore", async (req, res) => {
    const workspace = await workspaceFor(req);
    if (isAssistantRunning(workspace.id)) throw conflict("Stop the assistant before going back to a checkpoint");
    const result = await restoreCheckpoint(workspace.companyId, workspace.id, String(req.params.checkpointId), await ownerName(req.actor.userId));
    studioHub.broadcast(workspace.id, { type: "checkpoint:restored", checkpoint: result.restored });
    studioHub.broadcast(workspace.id, { type: "tree:changed" });
    await log(req, workspace, "studio.checkpoint_restored", { checkpointId: result.restored.id, label: result.restored.label });
    res.json(result);
  });

  // One change the assistant made, reversed (the Undo beside the step).
  router.post("/studio/workspaces/:id/edits/:editId/undo", async (req, res) => {
    const workspace = await workspaceFor(req);
    if (isAssistantRunning(workspace.id)) throw conflict("Stop the assistant before undoing one of its changes");
    const editId = String(req.params.editId);
    const result = await undoEdit(workspace.companyId, workspace.id, { id: editId }, `${await ownerName(req.actor.userId)} (undo)`);
    await broadcastFile(workspace, result.undone.path, "undo");
    const turn = await markEditUndone(workspace.companyId, workspace.id, editId);
    if (turn) studioHub.broadcast(workspace.id, { type: "assistant", turn, done: true });
    await log(req, workspace, "studio.edit_undone", { editId, path: result.undone.path });
    res.json({ path: result.undone.path, undoId: result.undo.id });
  });

  router.delete("/studio/workspaces/:id/checkpoints/:checkpointId", async (req, res) => {
    const workspace = await workspaceFor(req);
    await deleteCheckpoint(workspace.companyId, workspace.id, String(req.params.checkpointId));
    await log(req, workspace, "studio.checkpoint_deleted", { checkpointId: String(req.params.checkpointId) });
    res.json({ ok: true });
  });

  // ── Inline suggestions ───────────────────────────────────────────────────

  router.post("/studio/workspaces/:id/complete", validate(studioCompleteSchema), async (req, res) => {
    const controller = new AbortController();
    // The request's own "close" fires as soon as its body is read; only the
    // response closing unanswered means the editor stopped waiting.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const workspace = await workspaceFor(req);
    // Suggestions are paid calls too; a company over its hard-stop gets none.
    if (await budgets.getCompanyInvocationBlock(workspace.companyId)) {
      res.json({ completion: "", model: req.body.model ?? null, error: "AI is paused: this organization reached its budget limit." });
      return;
    }
    const provider = req.body.provider as StudioAiProvider;
    const credentials = await svc.resolveAiKey(workspace.companyId, actor(req), provider);
    if (!credentials) throw unprocessable("Add your API key for this provider first", { code: "studio_ai_key_missing" });
    const model = req.body.model?.trim() || STUDIO_AI_PROVIDER_INFO[provider].completionModel;
    if (!model) throw unprocessable("Pick a model for suggestions");
    try {
      const completion = await completeCode({
        provider,
        model,
        credentials,
        path: normalizeStudioPath(req.body.path),
        prefix: req.body.prefix.slice(-6000),
        suffix: req.body.suffix.slice(0, 2000),
        signal: controller.signal,
        onUsage: (usage) => studioUsage.recordSuggestion(workspace.companyId, usage),
      });
      res.json({ completion, model });
    } catch (error) {
      if (controller.signal.aborted) return;
      res.json({ completion: "", model, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/studio/workspaces/:id/download", async (req, res) => {
    const workspace = await workspaceFor(req);
    const root = studioWorkspaceDirs(workspace.companyId, workspace.id).files;
    const absolute = await resolveInside(root, String(req.query.path ?? ""));
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) throw notFound("File not found");
    sendDownload(res, absolute, path.basename(absolute));
  });

  // ── Running ──────────────────────────────────────────────────────────────

  router.post("/studio/workspaces/:id/run", validate(studioRunSchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    if (req.body.command?.trim()) {
      await svc.update(workspace.id, { runCommand: req.body.command });
      workspace.runCommand = req.body.command.trim();
    }
    await startApp(workspace);
    await svc.touch(workspace.id, true);
    await log(req, workspace, "studio.app_started", { command: workspace.runCommand ?? null });
    res.json({ run: studioRuntime(workspace.id).state });
  });

  router.post("/studio/workspaces/:id/stop", async (req, res) => {
    const workspace = await workspaceFor(req);
    const runtime = studioRuntime(workspace.id);
    await runtime.stop();
    await log(req, workspace, "studio.app_stopped");
    res.json({ run: runtime.state });
  });

  router.get("/studio/workspaces/:id/console", async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ lines: studioRuntime(workspace.id).consoleSince(Number(req.query.after) || 0) });
  });

  router.delete("/studio/workspaces/:id/console", async (req, res) => {
    const workspace = await workspaceFor(req);
    studioRuntime(workspace.id).clearConsole();
    await log(req, workspace, "studio.console_cleared");
    res.json({ ok: true });
  });

  router.post("/studio/workspaces/:id/console/input", validate(studioConsoleInputSchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    if (!studioRuntime(workspace.id).input(req.body.text)) throw conflict("Nothing is running to type into");
    res.json({ ok: true });
  });

  router.post("/studio/workspaces/:id/exec", validate(execStudioCommandSchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    await log(req, workspace, "studio.command_run", { command: String(req.body.command).slice(0, 500) });
    const result = await studioRuntime(workspace.id).exec(studioWorkspaceDirs(workspace.companyId, workspace.id).files, req.body.command, {
      timeoutMs: 15 * 60_000,
    });
    studioHub.broadcast(workspace.id, { type: "tree:changed" });
    res.json(result);
  });

  router.post("/studio/workspaces/:id/install-toolchain", async (req, res) => {
    const workspace = await workspaceFor(req);
    const language = studioLanguage(workspace.language);
    const command = language ? installCommandFor(language) : null;
    if (!command) throw unprocessable("Automa doesn't know how to install this language here. Install it yourself, then tap Run.");
    if (command.startsWith("sudo ")) throw unprocessable(`Run this in a terminal on the server: ${command}`);
    await log(req, workspace, "studio.toolchain_installed", { command });
    // On a phone the sturdier installer runs (it survives Android clearing apt's cache mid-download).
    const exec = installExecCommandFor(language!) ?? command;
    const result = await studioRuntime(workspace.id).exec(studioWorkspaceDirs(workspace.companyId, workspace.id).files, exec, { timeoutMs: 20 * 60_000 });
    clearToolchainCache();
    res.json({ ...result, toolchain: toolchainStatus(language!) });
  });

  router.post("/studio/workspaces/:id/public-link", async (req, res) => {
    const workspace = await workspaceFor(req);
    const runtime = studioRuntime(workspace.id);
    if (!runtime.running || !runtime.state.port) {
      await startApp(workspace);
      await svc.touch(workspace.id, true);
    }
    const port = runtime.state.port;
    if (!port) throw conflict("Start the app first");
    if (runtime.state.publicUrl && runtime.tunnelProcess) {
      res.json({ run: runtime.state });
      return;
    }
    runtime.setTunnel({ tunnelStatus: "starting", tunnelError: null, publicUrl: null });
    try {
      const tunnel = await openQuickTunnel(port, (detail) => {
        // A link closed on purpose (or when the app stopped) is not an error.
        if (runtime.tunnelProcess !== tunnel.process) return;
        runtime.tunnelProcess = null;
        runtime.setTunnel({ tunnelStatus: "off", publicUrl: null, tunnelError: detail });
      });
      if (!runtime.running || runtime.state.port !== port) {
        tunnel.process.kill("SIGTERM");
        throw new Error("The app stopped before its public link was ready. Run it and try again.");
      }
      // A second tap opened one meanwhile: keep that link, or this one could never be closed.
      if (runtime.tunnelProcess) {
        tunnel.process.kill("SIGTERM");
        res.json({ run: runtime.state });
        return;
      }
      // The runtime ends the link when the app stops or exits.
      runtime.tunnelProcess = tunnel.process;
      runtime.setTunnel({ tunnelStatus: "on", publicUrl: tunnel.url, tunnelError: null });
      runtime.append("system", `Public link: ${tunnel.url} (anyone with it can open your app while it runs).`);
      await log(req, workspace, "studio.public_link_opened", { url: tunnel.url });
      res.json({ run: runtime.state });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.setTunnel({ tunnelStatus: "failed", tunnelError: message, publicUrl: null });
      throw unprocessable(message, { code: cloudflaredPath() ? "studio_tunnel_failed" : "studio_cloudflared_missing" });
    }
  });

  router.delete("/studio/workspaces/:id/public-link", async (req, res) => {
    const workspace = await workspaceFor(req);
    const runtime = studioRuntime(workspace.id);
    runtime.tunnelProcess?.kill("SIGTERM");
    runtime.tunnelProcess = null;
    runtime.setTunnel({ tunnelStatus: "off", publicUrl: null, tunnelError: null });
    await log(req, workspace, "studio.public_link_closed");
    res.json({ run: runtime.state });
  });

  router.post("/companies/:companyId/studio/cloudflared", async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, String(req.params.companyId));
    const lines: string[] = [];
    const result = await installCloudflared((line) => lines.push(line));
    res.json({ ...result, log: lines.slice(-40) });
  });

  // ── Sharing and collaborators ────────────────────────────────────────────

  router.post("/studio/workspaces/:id/share", validate(shareStudioSchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    const shared = await svc.enableShare(workspace.id, { expiresInHours: req.body.expiresInHours, newCode: req.body.newCode === true });
    const gatewayPort = await gateway.start();
    let publicUrl: string | null = null;
    let publicError: string | null = null;
    if (req.body?.public !== false) {
      try {
        publicUrl = await ensureGatewayPublicUrl();
      } catch (error) {
        publicError = error instanceof Error ? error.message : String(error);
      }
    }
    studioHub.broadcast(workspace.id, { type: "share", shareEnabled: true });
    await log(req, workspace, req.body.newCode ? "studio.share_code_replaced" : "studio.share_enabled", { expiresAt: shared.shareExpiresAt });
    res.json({
      workspace: shared,
      code: shared.shareCode,
      inviteUrl: publicUrl ? `${publicUrl}/studio-guest/?code=${shared.shareCode}` : null,
      localInviteUrl: `http://127.0.0.1:${gatewayPort}/studio-guest/?code=${shared.shareCode}`,
      publicError,
    });
  });

  router.delete("/studio/workspaces/:id/share", async (req, res) => {
    const workspace = await workspaceFor(req);
    const updated = await svc.disableShare(workspace.id);
    studioHub.kickGuests(workspace.id, "The owner stopped sharing this project.");
    studioHub.broadcast(workspace.id, { type: "share", shareEnabled: false });
    await log(req, workspace, "studio.share_disabled");
    res.json({ workspace: updated });
  });

  router.get("/studio/workspaces/:id/collaborators", async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ collaborators: await svc.collaborators(workspace.id), participants: studioHub.participants(workspace.id) });
  });

  router.delete("/studio/workspaces/:id/collaborators/:collaboratorId", async (req, res) => {
    const workspace = await workspaceFor(req);
    const removed = await svc.removeCollaborator(workspace.id, String(req.params.collaboratorId));
    studioHub.kickGuests(workspace.id, "The owner removed you from this project.", removed.id);
    await log(req, workspace, "studio.collaborator_removed", { collaborator: removed.displayName });
    res.json({ collaborator: removed });
  });

  router.get("/studio/workspaces/:id/messages", async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ messages: await svc.messages(workspace.id) });
  });

  router.post("/studio/workspaces/:id/messages", async (req, res) => {
    const workspace = await workspaceFor(req);
    await readMultipart(attachmentUpload.single("file"), req, res);
    const parsed = postStudioMessageSchema.safeParse({ body: typeof req.body?.body === "string" ? req.body.body : "" });
    if (!parsed.success) throw badRequest("Message is too long");
    const attachment = req.file ? await saveAttachment(workspace, req.file) : null;
    const message = await svc.postMessage({
      workspace,
      authorType: "owner",
      authorName: await ownerName(req.actor.userId),
      body: parsed.data.body,
      attachment,
    });
    studioHub.broadcast(workspace.id, { type: "chat", message });
    res.status(201).json({ message });
  });

  router.get("/studio/workspaces/:id/shared/:attachmentId", async (req, res) => {
    const workspace = await workspaceFor(req);
    const file = await attachmentPath(workspace, String(req.params.attachmentId));
    sendDownload(res, file.absolute, file.name);
  });

  router.post("/studio/workspaces/:id/shared/:attachmentId/add", async (req, res) => {
    const workspace = await workspaceFor(req);
    const file = await attachmentPath(workspace, String(req.params.attachmentId));
    const saved = await saveUploadedFile(studioWorkspaceDirs(workspace.companyId, workspace.id).files, typeof req.body?.folder === "string" ? req.body.folder : null, file.name, await fs.readFile(file.absolute));
    studioHub.broadcast(workspace.id, { type: "tree:changed" });
    await log(req, workspace, "studio.shared_file_added", { path: saved });
    res.status(201).json({ path: saved });
  });

  router.get("/studio/workspaces/:id/changes", async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ changeRequests: await svc.changeRequests(workspace.id) });
  });

  router.post("/studio/workspaces/:id/changes/:changeId/accept", validate(resolveStudioChangeRequestSchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    const row = await svc.getChangeRequest(workspace.id, String(req.params.changeId));
    if (row.status !== "open") throw conflict("This change request was already handled");
    const edited = new Map<string, string | null>((req.body.files ?? []).map((file: { path: string; after: string | null }) => [normalizeStudioPath(file.path), file.after]));
    const files: StudioChangeFile[] = row.files.map((file) => (edited.has(normalizeStudioPath(file.path)) ? { ...file, after: edited.get(normalizeStudioPath(file.path))! } : file));
    // Taken first, so a reject at the same moment either wins (nothing is written) or is refused.
    const resolved = await svc.resolveChangeRequest(workspace.id, row.id, "accepted", req.actor.userId ?? null, files);
    await createCheckpoint(workspace.companyId, workspace.id, { label: `Before ${row.authorName}'s change`, kind: "change", by: await ownerName(req.actor.userId) }).catch(() => null);
    try {
      await applyChangeFiles(workspace, files);
    } catch (error) {
      await svc.reopenChangeRequest(workspace.id, row.id, row.files).catch(() => undefined);
      throw error;
    }
    for (const file of files) await broadcastFile(workspace, file.path, actor(req));
    studioHub.broadcast(workspace.id, { type: "change:resolved", changeRequest: resolved });
    await log(req, workspace, "studio.change_accepted", { changeRequestId: row.id, author: row.authorName, files: files.map((file) => file.path) });
    res.json({ changeRequest: resolved });
  });

  router.post("/studio/workspaces/:id/changes/:changeId/reject", async (req, res) => {
    const workspace = await workspaceFor(req);
    const resolved = await svc.resolveChangeRequest(workspace.id, String(req.params.changeId), "rejected", req.actor.userId ?? null);
    studioHub.broadcast(workspace.id, { type: "change:resolved", changeRequest: resolved });
    await log(req, workspace, "studio.change_rejected", { changeRequestId: resolved.id, author: resolved.authorName });
    res.json({ changeRequest: resolved });
  });

  // ── Assistant ────────────────────────────────────────────────────────────

  router.get("/companies/:companyId/studio/usage", async (req, res) => {
    assertBoard(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const days = Math.min(365, Math.max(1, Math.floor(Number(req.query.days)) || 30));
    res.json(await studioModelUsage(db, companyId, new Date(Date.now() - days * 24 * 60 * 60 * 1000)));
  });

  router.get("/companies/:companyId/studio/ai-keys", async (req, res) => {
    assertBoard(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.json({ keys: await svc.aiKeyStatuses(companyId, actor(req)) });
  });

  router.put("/companies/:companyId/studio/ai-keys", validate(saveStudioAiKeySchema), async (req, res) => {
    assertBoard(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const status = await svc.saveAiKey(companyId, actor(req), req.body.provider, req.body.apiKey, req.body.baseUrl ?? null);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor(req),
      action: "studio.ai_key_saved",
      entityType: "studio_ai_key",
      entityId: req.body.provider,
      details: { provider: req.body.provider, last4: status.last4 },
    });
    res.json({ key: status });
  });

  router.delete("/companies/:companyId/studio/ai-keys/:provider", async (req, res) => {
    assertBoard(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const provider = String(req.params.provider) as StudioAiProvider;
    if (!(STUDIO_AI_PROVIDERS as readonly string[]).includes(provider)) throw badRequest("Unknown provider");
    await svc.deleteAiKey(companyId, actor(req), provider);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor(req),
      action: "studio.ai_key_removed",
      entityType: "studio_ai_key",
      entityId: provider,
      details: { provider },
    });
    res.json({ ok: true });
  });

  router.get("/studio/workspaces/:id/assistant", async (req, res) => {
    const workspace = await workspaceFor(req);
    const turns = await readAssistantTranscript(workspace.companyId, workspace.id);
    // The reply being written right now, so a reload mid-turn still shows it.
    const live = currentAssistantTurn(workspace.id);
    res.json({ turns: live && !turns.some((turn) => turn.id === live.id) ? [...turns, live] : turns, running: isAssistantRunning(workspace.id) });
  });

  router.post("/studio/workspaces/:id/assistant", validate(studioAssistantMessageSchema), async (req, res) => {
    const workspace = await workspaceFor(req);
    // The slot is taken before anything is awaited, so two messages sent at
    // once get one reply and one clear "still working", not a server error.
    if (isAssistantRunning(workspace.id) || startingAssistant.has(workspace.id)) {
      throw conflict("The assistant is still working; wait or tap Stop");
    }
    startingAssistant.add(workspace.id);
    try {
      await assertStudioAiAllowed(workspace.companyId);
      const credentials = await svc.resolveAiKey(workspace.companyId, actor(req), req.body.provider);
      if (!credentials) throw unprocessable("Add your API key for this provider first", { code: "studio_ai_key_missing" });
      // Each teammate model brings its own key; a missing one stops the turn
      // before anything is spent, naming the provider.
      const team: Parameters<typeof runAssistantTurn>[0]["team"] = [];
      for (const mate of (req.body.team ?? []) as Array<{ provider: StudioAiProvider; model: string }>) {
        const mateCredentials = await svc.resolveAiKey(workspace.companyId, actor(req), mate.provider);
        if (!mateCredentials) throw unprocessable(`Add your API key for ${STUDIO_AI_PROVIDER_INFO[mate.provider].name} first (teammate ${mate.model})`, { code: "studio_ai_key_missing" });
        team.push({ provider: mate.provider, model: mate.model, credentials: mateCredentials });
      }
      // Saved first, so whatever the assistant does can be undone.
      const checkpoint = await createCheckpoint(workspace.companyId, workspace.id, {
        label: `Before AI: ${(req.body.message || req.body.attachments?.[0]?.name || "attachment").replace(/\s+/g, " ").slice(0, 80)}`,
        kind: "assistant",
        by: "AI assistant",
      }).catch(() => null);
      const { userTurn } = await startAssistantTurn(workspace, checkpoint?.id ?? null, credentials, req.body, team);
      await log(req, workspace, "studio.assistant_asked", { provider: req.body.provider, model: req.body.model ?? null, thinking: req.body.thinking ?? null, team: team.map((mate) => `${mate.provider}:${mate.model}`) });
      res.status(202).json({ turn: userTurn });
    } finally {
      startingAssistant.delete(workspace.id);
    }
  });

  function startAssistantTurn(
    workspace: WorkspaceRow,
    checkpointId: string | null,
    credentials: NonNullable<Awaited<ReturnType<typeof svc.resolveAiKey>>>,
    body: {
      message?: string;
      provider: StudioAiProvider;
      model: string;
      attachments?: Parameters<typeof runAssistantTurn>[0]["attachments"];
      thinking?: Parameters<typeof runAssistantTurn>[0]["thinking"];
    },
    team: Parameters<typeof runAssistantTurn>[0]["team"] = [],
  ) {
    return runAssistantTurn({
      checkpointId,
      team,
      context: {
        workspaceId: workspace.id,
        companyId: workspace.companyId,
        name: workspace.name,
        language: workspace.language,
        runCommand: runCommandFor(workspace).command,
        startApp: () => startApp(workspace),
        onFileChanged: (relative) => broadcastFile(workspace, relative, "assistant"),
        onUsage: (usage) => studioUsage.recordReply(workspace.companyId, usage),
      },
      message: body.message ?? "",
      provider: body.provider,
      model: body.model,
      attachments: body.attachments ?? [],
      ...(body.thinking ? { thinking: body.thinking } : {}),
      credentials,
    });
  }

  router.post("/studio/workspaces/:id/assistant/stop", async (req, res) => {
    const workspace = await workspaceFor(req);
    stopAssistant(workspace.id);
    await log(req, workspace, "studio.assistant_stopped");
    res.json({ ok: true });
  });

  router.delete("/studio/workspaces/:id/assistant", async (req, res) => {
    const workspace = await workspaceFor(req);
    if (isAssistantRunning(workspace.id) || startingAssistant.has(workspace.id)) throw conflict("Stop the assistant first");
    await clearAssistantConversation(workspace.companyId, workspace.id);
    studioHub.broadcast(workspace.id, { type: "assistant:cleared" });
    await log(req, workspace, "studio.assistant_cleared");
    res.json({ ok: true });
  });

  return router;
}

/**
 * The sandboxed preview has no origin, so the browser refuses a page's
 * localStorage and sessionStorage and a page that saves anything stops with
 * an error. This stands in for them with in-memory storage while the page is
 * open; the page's own public link keeps real storage.
 */
export const PREVIEW_STORAGE_SHIM = `<script>(function(){function m(){var d=Object.create(null);return{get length(){return Object.keys(d).length},key:function(i){var k=Object.keys(d);return i>=0&&i<k.length?k[i]:null},getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)}}}["localStorage","sessionStorage"].forEach(function(n){try{void window[n].length}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true,enumerable:true})}catch(_){}}})})();</script>`;

/**
 * Puts tags at the start of a previewed page's head, before any of its own
 * scripts run: after `<head>`, else after `<html>`, else after the doctype,
 * so a page never drops into quirks mode and a `<header>` is never taken for
 * the head.
 */
export function injectIntoPreviewHtml(html: string, tags: string): string {
  for (const pattern of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /^\s*<!doctype[^>]*>/i]) {
    const match = pattern.exec(html);
    if (match) return `${html.slice(0, match.index + match[0].length)}${tags}${html.slice(match.index + match[0].length)}`;
  }
  return `${tags}${html}`;
}

/**
 * Response headers a previewed app can't send through Automa: the ones
 * Automa sets itself, and ones that act on all of Automa's site (wiping its
 * cookies and storage, or setting its reporting and transport rules).
 */
const PREVIEW_DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "x-frame-options",
  "content-security-policy",
  "content-length",
  "transfer-encoding",
  "connection",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "clear-site-data",
  "nel",
  "report-to",
  "reporting-endpoints",
  "alt-svc",
  "strict-transport-security",
]);

/**
 * Routes that do not use the board session: collaborators (with the token
 * they got from a share code) and the running app's preview (with its
 * per-run random path). Mounted before the board-only middleware.
 */
export function studioPublicRoutes(db: Db) {
  const router = Router();
  const svc = studioService(db);

  async function guestFor(req: Request) {
    const token = (req.header("x-studio-guest") ?? (typeof req.query.token === "string" ? req.query.token : "")).trim();
    const guest = await svc.guestByToken(token);
    if (!guest) throw unauthorized("Your invite ended or the code is wrong. Ask for a new code.");
    return guest;
  }

  function guestParticipant(guest: NonNullable<Awaited<ReturnType<typeof svc.guestByToken>>>): StudioParticipant {
    return { id: `guest:${guest.collaborator.id}`, name: guest.collaborator.displayName, role: "guest", color: guest.collaborator.color, activePath: null, online: true };
  }

  router.post("/studio-guest/join", validate(joinStudioSchema), async (req, res) => {
    // Wrong codes are counted per client and overall, so a code can't be guessed.
    const limiterKey = joinLimiterKey(req);
    const gate = joinLimiter.check(limiterKey);
    if (!gate.allowed) {
      res.set("Retry-After", String(gate.retryAfterSeconds));
      throw tooManyRequests(`Too many tries. Wait ${gate.retryAfterSeconds} seconds and check the code.`);
    }
    let joined: Awaited<ReturnType<typeof svc.join>>;
    try {
      joined = await svc.join(req.body.code, req.body.name);
    } catch (error) {
      joinLimiter.recordFailure(limiterKey);
      throw error;
    }
    joinLimiter.recordSuccess(limiterKey);
    const message = await svc.postMessage({
      workspace: joined.workspace,
      authorType: "system",
      authorName: "Automa",
      body: `${joined.collaborator.displayName} joined.`,
    });
    studioHub.broadcast(joined.workspace.id, { type: "chat", message });
    res.status(201).json({
      token: joined.token,
      collaborator: joined.collaborator,
      workspace: { id: joined.workspace.id, name: joined.workspace.name, language: joined.workspace.language },
    });
  });

  router.get("/studio-guest/workspace", async (req, res) => {
    const guest = await guestFor(req);
    res.json({
      workspace: { id: guest.workspace.id, name: guest.workspace.name, language: guest.workspace.language },
      you: guestParticipant(guest),
      participants: studioHub.participants(guest.workspace.id),
      run: existingStudioRuntime(guest.workspace.id)?.state ?? null,
    });
  });

  router.get("/studio-guest/tree", async (req, res) => {
    const guest = await guestFor(req);
    res.json({ tree: await listTree(studioWorkspaceDirs(guest.workspace.companyId, guest.workspace.id).files) });
  });

  router.get("/studio-guest/file", async (req, res) => {
    const guest = await guestFor(req);
    res.json(await readStudioFile(studioWorkspaceDirs(guest.workspace.companyId, guest.workspace.id).files, String(req.query.path ?? "")));
  });

  router.get("/studio-guest/raw", async (req, res) => {
    const guest = await guestFor(req);
    await sendRaw(res, studioWorkspaceDirs(guest.workspace.companyId, guest.workspace.id).files, String(req.query.path ?? ""));
  });

  router.get("/studio-guest/archive", async (req, res) => {
    const guest = await guestFor(req);
    const relative = typeof req.query.path === "string" && req.query.path.trim() ? normalizeStudioPath(req.query.path) : "";
    await sendZip(res, studioWorkspaceDirs(guest.workspace.companyId, guest.workspace.id).files, relative, guest.workspace.name);
  });

  router.get("/studio-guest/console", async (req, res) => {
    const guest = await guestFor(req);
    res.json({ lines: existingStudioRuntime(guest.workspace.id)?.consoleSince(Number(req.query.after) || 0) ?? [] });
  });

  router.get("/studio-guest/messages", async (req, res) => {
    const guest = await guestFor(req);
    res.json({ messages: await svc.messages(guest.workspace.id) });
  });

  router.post("/studio-guest/messages", async (req, res) => {
    const guest = await guestFor(req);
    await readMultipart(attachmentUpload.single("file"), req, res);
    const parsed = postStudioMessageSchema.safeParse({ body: typeof req.body?.body === "string" ? req.body.body : "" });
    if (!parsed.success) throw badRequest("Message is too long");
    const attachment = req.file ? await saveAttachment(guest.workspace, req.file) : null;
    const message = await svc.postMessage({
      workspace: guest.workspace,
      authorType: "guest",
      authorName: guest.collaborator.displayName,
      collaboratorId: guest.collaborator.id,
      body: parsed.data.body,
      attachment,
    });
    studioHub.broadcast(guest.workspace.id, { type: "chat", message });
    res.status(201).json({ message });
  });

  router.get("/studio-guest/shared/:attachmentId", async (req, res) => {
    const guest = await guestFor(req);
    const file = await attachmentPath(guest.workspace, String(req.params.attachmentId));
    sendDownload(res, file.absolute, file.name);
  });

  router.get("/studio-guest/changes", async (req, res) => {
    const guest = await guestFor(req);
    const all = await svc.changeRequests(guest.workspace.id);
    res.json({ changeRequests: all.filter((change) => change.collaboratorId === guest.collaborator.id) });
  });

  router.post("/studio-guest/changes", validate(createStudioChangeRequestSchema), async (req, res) => {
    const guest = await guestFor(req);
    // The owner reviews the change against the file as it is right now.
    const dirs = studioWorkspaceDirs(guest.workspace.companyId, guest.workspace.id);
    const files: StudioChangeFile[] = [];
    for (const file of req.body.files as Array<{ path: string; after: string | null }>) {
      const relative = normalizeStudioPath(file.path);
      const current = await readStudioFile(dirs.files, relative).catch(() => null);
      if (current && current.content === null) throw unprocessable(`${relative} is too large or not text; share it in the chat instead`);
      const before = current?.content ?? null;
      if (before === file.after) continue;
      files.push({ path: relative, before, after: file.after });
    }
    if (files.length === 0) throw unprocessable("Nothing changed in these files");
    const changeRequest = await svc.createChangeRequest({
      workspace: guest.workspace,
      collaboratorId: guest.collaborator.id,
      authorName: guest.collaborator.displayName,
      message: req.body.message,
      files,
    });
    studioHub.broadcast(guest.workspace.id, { type: "change:new", changeRequest });
    res.status(201).json({ changeRequest });
  });

  // The running app, through Automa. The path's random token is the key, and
  // the response is sandboxed so the app's code can't act as you in Automa.
  router.all("/studio-preview/:token{/*rest}", async (req, res) => {
    const runtime = studioRuntimeByPreviewToken(String(req.params.token));
    if (!runtime || !runtime.state.port) {
      res.status(404).type("text/plain").send("This preview ended. Run the app again in Automa Studio.");
      return;
    }
    // The sandboxed preview has an opaque origin, so its own fetch() calls
    // are cross-origin. No cookies or auth ever pass through here, so any
    // origin may read the app's responses.
    if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": String(req.headers["access-control-request-headers"] ?? "content-type"),
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }
    const prefix = `/api/studio-preview/${String(req.params.token)}/`;
    const rest = req.params.rest;
    const restPath = Array.isArray(rest) ? rest.join("/") : typeof rest === "string" ? rest : "";
    const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || ["cookie", "authorization", "host", "content-length", "connection"].includes(key)) continue;
      headers[key] = value;
    }
    headers.host = `127.0.0.1:${runtime.state.port}`;
    headers["accept-encoding"] = "identity";
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (rawBody) headers["content-length"] = String(rawBody.length);
    const upstream = httpRequest(
      { host: "127.0.0.1", port: runtime.state.port, method: req.method, path: `/${restPath}${query}`, headers },
      (upstreamRes) => {
        const outHeaders: Record<string, string | string[] | number> = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined || PREVIEW_DROPPED_RESPONSE_HEADERS.has(key)) continue;
          outHeaders[key] = value;
        }
        if (typeof outHeaders.location === "string" && outHeaders.location.startsWith("/")) outHeaders.location = `${prefix}${outHeaders.location.slice(1)}`;
        outHeaders["content-security-policy"] = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-presentation";
        outHeaders["x-content-type-options"] = "nosniff";
        outHeaders["access-control-allow-origin"] = "*";
        const isHtml = String(upstreamRes.headers["content-type"] ?? "").includes("text/html");
        if (!isHtml) {
          res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
          upstreamRes.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf8");
          // Root-relative links ("/style.css") point back into the preview.
          html = html.replace(/(\s(?:src|href|action)=["'])\/(?!\/)/gi, `$1${prefix}`);
          res.writeHead(upstreamRes.statusCode ?? 200, outHeaders);
          res.end(injectIntoPreviewHtml(html, `${/<base\s/i.test(html) ? "" : `<base href="${prefix}">`}${PREVIEW_STORAGE_SHIM}`));
        });
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.status(502).type("text/plain").send(`Your app is not answering yet: ${error.message}`);
    });
    if (rawBody) upstream.end(rawBody);
    else req.pipe(upstream);
  });

  return router;
}
