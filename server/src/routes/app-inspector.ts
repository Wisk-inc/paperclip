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
  inspectorProjectView,
  inspectorStatus,
  listInspectorDir,
  listInspectorProjects,
  listInstalledApps,
  readInspectorFile,
  resolveInstalledApkPath,
  startDecode,
  startRebuild,
  writeInspectorFile,
} from "../services/app-inspector/inspector.js";

const openSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("installed"), package: z.string().min(1).max(256) }),
    z.object({ kind: z.literal("path"), apkPath: z.string().min(1).max(4096) }),
  ]),
  label: z.string().max(200).optional(),
});
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
      const apkPath = body.source.kind === "installed" ? await resolveInstalledApkPath(body.source.package) : body.source.apkPath;
      const label = body.label || (body.source.kind === "installed" ? body.source.package : undefined) || "app";
      const view = await startDecode({ companyId, apkPath, label });
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
      throw unprocessable(error instanceof Error ? error.message : "Could not open that app");
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
      res.json({ entries: await listInspectorDir(companyId, req.params.id as string, String(req.query.path ?? "")) });
    } catch (error) {
      throw unprocessable(error instanceof Error ? error.message : "Could not read that folder");
    }
  });

  router.get("/companies/:companyId/app-inspector/projects/:id/file", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    project(req);
    const filePath = z.string().min(1).max(4096).parse(req.query.path);
    try {
      res.json(await readInspectorFile(companyId, req.params.id as string, filePath));
    } catch (error) {
      throw unprocessable(error instanceof Error ? error.message : "Could not read that file");
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
      throw unprocessable(error instanceof Error ? error.message : "Could not save that file");
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
      throw unprocessable(error instanceof Error ? error.message : "Could not rebuild");
    }
  });

  router.delete("/companies/:companyId/app-inspector/projects/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    res.json({ ok: await deleteInspectorProject(companyId, z.string().uuid().parse(req.params.id)) });
  });

  router.post("/companies/:companyId/app-inspector/projects/:id/explain", validate(z.object({ path: z.string().min(1).max(4096) })), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    project(req);
    const filePath = z.string().min(1).max(4096).parse(req.body.path);
    const key = await connections.credentialForProvider(companyId, getActorInfo(req).actorId, "anthropic").catch(() => null);
    if (!key) throw unprocessable("Add an Anthropic API key on the API keys page to use Claude here.");
    const { text } = await readInspectorFile(companyId, req.params.id as string, filePath);
    const client = new Anthropic({ apiKey: key, authToken: null, maxRetries: 2 });
    try {
      const message = await client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 1024,
        system:
          "You explain decompiled Android app files for a developer inspecting an app they are authorized to analyze. Say what the file is and what it does, in plain language. Be concise.",
        messages: [{ role: "user", content: `File: ${filePath}\n\n${text.slice(0, 12000)}` }],
      });
      const answer = message.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n").trim();
      res.json({ explanation: answer || "Claude had nothing to add." });
    } catch (error) {
      throw unprocessable(error instanceof Error ? `Claude couldn't read it: ${error.message}` : "Claude couldn't read it");
    }
  });

  return router;
}
