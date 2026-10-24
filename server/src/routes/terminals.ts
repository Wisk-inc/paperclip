import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { isTerminalToolId } from "@paperclipai/shared";
import { assertCompanyAccess } from "./authz.js";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { supportsLocalAiLogin } from "../services/local-ai-login-policy.js";
import { terminalStatus } from "../services/terminals/status.js";
import {
  listTerminalSessions,
  startTerminalSession,
  stopTerminalSession,
} from "../services/terminals/sessions.js";

const startSchema = z.object({
  toolId: z.string().refine(isTerminalToolId, "Unknown terminal tool"),
  mode: z.enum(["run", "install", "setup", "shell"]),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  cwd: z.string().max(4096).optional(),
  agentId: z.string().uuid().optional(),
});

/**
 * Terminals run real programs on the device Automa runs on, so they are for the
 * device's own operator only: the local owner (a phone, or a computer running
 * Automa for itself) or an instance admin of such a deployment. A member of a
 * company on a shared, public server never gets a shell on the host.
 */
export function terminalsRoutes(
  db: Db,
  opts: { deploymentMode: DeploymentMode; deploymentExposure: DeploymentExposure },
) {
  const router = Router();
  const enabled = supportsLocalAiLogin({ deploymentMode: opts.deploymentMode, deploymentExposure: opts.deploymentExposure });

  function assertDeviceOperator(req: Request) {
    if (!enabled) throw forbidden("Terminals run on the device Automa runs on, and this instance is hosted for many people.");
    if (req.actor.source !== "local_implicit" && req.actor.isInstanceAdmin !== true) {
      throw forbidden("Only the operator of this device can open a terminal on it.");
    }
  }

  router.get("/companies/:companyId/terminals/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(await terminalStatus());
  });

  router.get("/companies/:companyId/terminals/sessions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({ sessions: listTerminalSessions(companyId) });
  });

  router.post("/companies/:companyId/terminals/sessions", validate(startSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    const body = startSchema.parse(req.body);
    try {
      const session = startTerminalSession({
        companyId,
        toolId: body.toolId,
        mode: body.mode,
        cols: body.cols ?? 80,
        rows: body.rows ?? 24,
        cwd: body.cwd,
        agentId: body.agentId ?? null,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "local-board",
        action: "terminal.opened",
        entityType: "terminal_session",
        entityId: session.id,
        details: { toolId: body.toolId, mode: body.mode },
      });
      res.status(201).json({ session });
    } catch (error) {
      throw unprocessable(error instanceof Error ? error.message : "Could not open the terminal");
    }
  });

  router.post("/companies/:companyId/terminals/sessions/:id/stop", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertDeviceOperator(req);
    const stopped = stopTerminalSession(companyId, z.string().uuid().parse(req.params.id));
    res.json({ ok: stopped });
  });

  return router;
}
