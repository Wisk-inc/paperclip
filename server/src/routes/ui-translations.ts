import { Router } from "express";
import { z } from "zod";
import { APP_LANGUAGE_CODES, type AppLanguageCode } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { sharedUiTranslationService } from "../services/ui-translations.js";
import { assertBoard } from "./authz.js";

/** Strings one request may ask for: the board sends what one screen shows. */
export const UI_TRANSLATION_REQUEST_MAX = 80;

const languageSchema = z.enum(APP_LANGUAGE_CODES);

export const uiTranslationRequestSchema = z
  .object({
    language: languageSchema,
    strings: z.array(z.string().min(1).max(2000)).min(1).max(UI_TRANSLATION_REQUEST_MAX),
  })
  .strict();

/**
 * Automa's screens in the person's language: every saved translation for a
 * language, and translations of board strings it does not have yet (made by
 * the free models, then saved). Board users only; only the board's own
 * strings are accepted (see services/ui-translations.ts).
 */
export function uiTranslationRoutes() {
  const router = Router();

  router.get("/ui-translations/:language", (req, res) => {
    assertBoard(req);
    const parsed = languageSchema.safeParse(req.params.language);
    if (!parsed.success) {
      res.status(400).json({ error: "Unknown language" });
      return;
    }
    const language: AppLanguageCode = parsed.data;
    res.json({ language, translations: language === "en" ? {} : sharedUiTranslationService().all(language) });
  });

  router.post("/ui-translations", validate(uiTranslationRequestSchema), async (req, res) => {
    assertBoard(req);
    const { language, strings } = req.body as z.infer<typeof uiTranslationRequestSchema>;
    const caller = req.actor.userId ?? `${req.actor.source ?? "board"}`;
    res.json({ language, ...(await sharedUiTranslationService().translate(language, strings, caller)) });
  });

  return router;
}
