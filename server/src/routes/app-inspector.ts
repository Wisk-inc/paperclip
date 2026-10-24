import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { assertCompanyAccess } from "./authz.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import Anthropic from "@anthropic-ai/sdk";
import { aiConnectionService } from "../services/ai-connections.js";
import { getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { supportsLocalAiLogin } from "../services/local-ai-login-policy.js";
import {
  deleteInspectorProject,
  getInspectorProject,
  inspectorAppInfo,
  inspectorErrorMessage,
  inspectorImageFile,
  inspectorOutputFile,
  inspectorProjectView,
  inspectorStatus,
  listInspectorDir,
  listInspectorProjects,
  listInstalledApps,
  readInspectorFile,
  resolveInstalledApkPath,
  searchInspector,
  startDecode,
  startDecodeFromStream,
  startRebuild,
  writeInspectorFile,
  type InspectorView,
} from "../services/app-inspector/inspector.js";

const openSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("installed"), package: z.string().min(1).max(256) }),
    z.object({ kind: z.literal("path"), apkPath: z.string().min(1).max(4096) }),
  ]),
  label: z.string().max(200).optional(),
  packageName: z.string().regex(/^[A-Za-z0-9_.]+$/).max(256).optional(),
  splitCount: z.number().int().min(0).max(999).optional(),
  options: z.object({ resources: z.boolean(), sources: z.boolean(), java: z.boolean() }).partial().optional(),
});
const flag = z.enum(["0", "1"]).transform((value) => value === "1");
const uploadQuery = z.object({
  label: z.string().max(200).optional(),
  package: z.string().regex(/^[A-Za-z0-9_.]+$/).max(256).optional(),
  splits: z.coerce.number().int().min(0).max(999).optional(),
  res: flag.optional(),
  src: flag.optional(),
  java: flag.optional(),
});
const viewSchema = z.enum(["files", "java"]).default("files");
const writeSchema = z.object({ path: z.string().min(1).max(4096), text: z.string().max(2 * 1024 * 1024) });

/**
 * The App Inspector: decode, read, edit and rebuild Android apps on the device.
 * For the device operator only, like terminals — not a member of a shared server.
 */
export function appInspectorRoutes(
  db: Db,
  opts: { deploymentMode: DeploymentMode; deploymentExposure: DeploymentExposure },
) {
  const router = Router();
  const connections = aiConnectionService(db);
  const enabled = supportsLocalAiLogin({ deploymentMode: opts.deploymentMode, deploymentExposure: opts.deploymentExposure });

  function assertDeviceOperator(req: Request) {
    if (!enabled) throw forbidden("The App Inspector runs on the device Automa runs on, and this instance is hosted for many people.");
    if (req.actor.source !== "local_implicit" && req.actor.isInstanceAdmin !== true) {
      throw forbidden("Only the operator of this device can use the App Inspector.");
    }
  }

  function project(req: Request) {
    const found = getInspectorProject(req.params.companyId as string, z.string().uuid().parse(req.params.id));
    if (!found) throw notFound("Inspector project not found");
    return found;
  }

  router.get("/companies/:companyId/app-inspector/status", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    assertDeviceOperator(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...(await inspectorStatus()), apps: await listInstalledApps() });
  });

  router.get("/companies/:companyId/app-inspector/projects", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    assertDeviceOperator(req);
    res.json({ projects: listInspectorProjects(req.params.companyId as string) });
  });

  router.post("/companies/:companyId/app-inspector/projects", validate(openSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    const body = openSchema.parse(req.body);
    try {
      const installed = body.source.kind === "installed" ? await resolveInstalledApkPath(body.source.package) : null;
      const apkPath = installed ? installed.apkPath : (body.source as { apkPath: string }).apkPath;
      const packageName = body.packageName ?? (body.source.kind === "installed" ? body.source.package : null);
      const label = body.label || packageName || "";
      const view = await startDecode({
        companyId,
        apkPath,
        label,
        packageName,
        splitCount: body.splitCount ?? installed?.splitCount ?? 0,
        options: body.options,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "local-board",
        action: "app_inspector.decoded",
        entityType: "app_inspector_project",
        entityId: view.id,
        details: { source: body.source.kind },
      });
      res.status(201).json({ project: view });
    } catch (error) {
      throw unprocessable(inspectorErrorMessage(error, "Could not open that app"));
    }
  });

  // The APK itself as the request body: the Automa app's picker sends the app
  // it read on the phone, a browser sends a chosen .apk file.
  router.put("/companies/:companyId/app-inspector/uploads", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    const query = uploadQuery.parse(req.query);
    try {
      const view = await startDecodeFromStream({
        companyId,
        label: query.label || query.package || "app",
        packageName: query.package ?? null,
        splitCount: query.splits ?? 0,
        options: { resources: query.res, sources: query.src, java: query.java },
        stream: req,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "local-board",
        action: "app_inspector.decoded",
        entityType: "app_inspector_project",
        entityId: view.id,
        details: { source: "upload" },
      });
      res.status(201).json({ project: view });
    } catch (error) {
      throw unprocessable(inspectorErrorMessage(error, "Could not open that APK"));
    }
  });

  router.get("/companies/:companyId/app-inspector/projects/:id", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    assertDeviceOperator(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({ project: inspectorProjectView(project(req)) });
  });

  router.get("/companies/:companyId/app-inspector/projects/:id/dir", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    project(req);
    try {
      const view: InspectorView = viewSchema.parse(req.query.view);
      res.json({ entries: await listInspectorDir(companyId, req.params.id as string, String(req.query.path ?? ""), view) });
    } catch (error) {
      throw unprocessable(inspectorErrorMessage(error, "Could not read that folder"));
    }
  });

  router.get("/companies/:companyId/app-inspector/projects/:id/file", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    project(req);
    const filePath = z.string().min(1).max(4096).parse(req.query.path);
    const view: InspectorView = viewSchema.parse(req.query.view);
    try {
      res.json(await readInspectorFile(companyId, req.params.id as string, filePath, view));
    } catch (error) {
      throw unprocessable(inspectorErrorMessage(error, "Could not read that file"));
    }
  });

  router.put("/companies/:companyId/app-inspector/projects/:id/file", validate(writeSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    project(req);
    const body = writeSchema.parse(req.body);
    try {
      await writeInspectorFile(companyId, req.params.id as string, body.path, body.text);
      res.json({ ok: true });
    } catch (error) {
      throw unprocessable(inspectorErrorMessage(error, "Could not save that file"));
    }
  });

  router.post("/companies/:companyId/app-inspector/projects/:id/rebuild", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    const current = project(req);
    try {
      const view = startRebuild(companyId, current.id);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "local-board",
        action: "app_inspector.rebuilt",
        entityType: "app_inspector_project",
        entityId: current.id,
      });
      res.json({ project: view });
    } catch (error) {
      throw unprocessable(inspectorErrorMessage(error, "Could not rebuild"));
    }
  });

  // Find files by name, or text inside them.
  router.get("/companies/:companyId/app-inspector/projects/:id/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    project(req);
    const query = z
      .object({ view: viewSchema, q: z.string().max(200), mode: z.enum(["name", "text"]).default("name") })
      .parse(req.query);
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await searchInspector(companyId, req.params.id as string, query.view, query.q, query.mode));
    } catch (error) {
      throw unprocessable(inspectorErrorMessage(error, "Could not search this app"));
    }
  });

  // An image in the project (icons, drawables) for thumbnails and previews.
  router.get("/companies/:companyId/app-inspector/projects/:id/image", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    project(req);
    const query = z.object({ view: viewSchema, path: z.string().min(1).max(4096) }).parse(req.query);
    let image: { file: string; type: string };
    try {
      image = await inspectorImageFile(companyId, req.params.id as string, query.view, query.path);
    } catch (error) {
      throw unprocessable(inspectorErrorMessage(error, "Could not open that image"));
    }
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(image.type);
    res.sendFile(image.file, { dotfiles: "allow" });
  });

  // Package, versions, SDKs, permissions and components, from the manifest.
  router.get("/companies/:companyId/app-inspector/projects/:id/info", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    project(req);
    try {
      res.json({ info: await inspectorAppInfo(companyId, req.params.id as string) });
    } catch (error) {
      throw unprocessable(inspectorErrorMessage(error, "Could not read this app's manifest"));
    }
  });

  // The rebuilt APK. In the Automa app this saves to the phone's Downloads
  // even when Termux can't write there.
  router.get("/companies/:companyId/app-inspector/projects/:id/output", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    project(req);
    const output = inspectorOutputFile(companyId, req.params.id as string);
    if (!output) throw notFound("Rebuild the app first");
    res.setHeader("Cache-Control", "no-store");
    res.type("application/vnd.android.package-archive");
    res.download(output.file, output.name);
  });

  router.delete("/companies/:companyId/app-inspector/projects/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    res.json({ ok: await deleteInspectorProject(companyId, z.string().uuid().parse(req.params.id)) });
  });

  router.post("/companies/:companyId/app-inspector/projects/:id/explain", validate(z.object({ path: z.string().min(1).max(4096), view: viewSchema.optional() })), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    project(req);
    const filePath = z.string().min(1).max(4096).parse(req.body.path);
    const view: InspectorView = viewSchema.parse(req.body.view);
    const file = await readInspectorFile(companyId, req.params.id as string, filePath, view).catch((error: unknown) => {
      throw unprocessable(inspectorErrorMessage(error, "Could not read that file"));
    });
    if (file.binary) throw unprocessable("That is a binary file; Claude reads text files (Java, smali, XML, JSON).");
    const key = await connections.credentialForProvider(companyId, getActorInfo(req).actorId, "anthropic").catch(() => null);
    if (!key) throw unprocessable("Add an Anthropic API key on the API keys page to use Claude here.");
    const client = new Anthropic({ apiKey: key, authToken: null, maxRetries: 2 });
    try {
      const message = await client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 1024,
        system:
          "You explain decompiled Android app files for a developer inspecting an app they are authorized to analyze. Say what the file is and what it does, in plain language, and point out the parts worth a closer look. Be concise.",
        messages: [
          {
            role: "user",
            content: `File (${view === "java" ? "Java decompiled by jadx" : "decoded by apktool"}): ${filePath}${file.text.length > 12000 ? " (first 12,000 characters)" : ""}\n\n${file.text.slice(0, 12000)}`,
          },
        ],
      });
      const answer = message.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n").trim();
      res.json({ explanation: answer || "Claude had nothing to add." });
    } catch (error) {
      throw unprocessable(error instanceof Error ? `Claude couldn't read it: ${error.message}` : "Claude couldn't read it");
    }
  });

  return router;
}
