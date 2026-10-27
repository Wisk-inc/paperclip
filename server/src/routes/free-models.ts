import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { FreeModelHealthMap } from "@paperclipai/shared";
import { freeModelHealth } from "@paperclipai/shared/puter-ai";
import { logActivity } from "../services/activity-log.js";
import { FREE_MODELS_RESET_ACTION, freeModelUsage } from "../services/free-models.js";
import { moanKnowledge } from "../services/moan/index.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

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

  // Each free model's last known state (daily limit, busy, closed by its
  // provider), for the model picker. Instance-level: it holds model ids and
  // times only, no company or user data.
  router.get("/free-models/health", async (req, res) => {
    assertAuthenticated(req);
    res.json(freeModelHealth() satisfies FreeModelHealthMap);
  });

  // Moan's Jamaican knowledge index is instance-level public content (see
  // doc/moan.md): any signed-in person or agent can read it; the board
  // starts a refresh.
  router.get("/free-models/moan/status", async (req, res) => {
    assertAuthenticated(req);
    res.json(await moanKnowledge(db).status());
  });

  router.post("/free-models/moan/refresh", async (req, res) => {
    assertAuthenticated(req);
    assertBoard(req);
    const force = (req.body as { force?: unknown } | undefined)?.force === true;
    const started = await moanKnowledge(db).refresh({ force });
    res.json({ ...started, status: await moanKnowledge(db).status() });
  });

  router.get("/free-models/moan/context", async (req, res) => {
    assertAuthenticated(req);
    const question = typeof req.query.q === "string" ? req.query.q.slice(0, 1_000) : "";
    res.json(await moanKnowledge(db).contextFor(question));
  });

  return router;
}
