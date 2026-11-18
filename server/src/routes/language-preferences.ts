import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { updateLanguagePreferenceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { languagePreferenceService } from "../services/language-preferences.js";
import { assertBoard } from "./authz.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

/**
 * The signed-in person's language: Auto or one they chose, and what Auto found
 * on their device. Instance-wide like the sidebar's company order, since a
 * person keeps one language in every organization; it holds no company data.
 */
export function languagePreferenceRoutes(db: Db) {
  const router = Router();
  const svc = languagePreferenceService(db);

  router.get("/language-preferences/me", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.get(userId));
  });

  router.put("/language-preferences/me", validate(updateLanguagePreferenceSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.update(userId, req.body));
  });

  return router;
}
