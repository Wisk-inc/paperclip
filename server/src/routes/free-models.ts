import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logActivity } from "../services/activity-log.js";
import { FREE_MODELS_RESET_ACTION, freeModelUsage } from "../services/free-models.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function freeModelRoutes(db: Db): Router {
  const router = Router();

  router.get("/companies/:companyId/free-models/usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await freeModelUsage(db, companyId));
  });

  router.post("/companies/:companyId/free-models/usage/reset", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: FREE_MODELS_RESET_ACTION,
      entityType: "company",
      entityId: companyId,
    });
    res.json(await freeModelUsage(db, companyId));
  });

  return router;
}
