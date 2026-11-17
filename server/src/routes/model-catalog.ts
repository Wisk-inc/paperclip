import { Router } from "express";
import { CATALOG_TOP_MAKERS, isCatalogChatModel, type ModelCatalogSnapshot } from "@paperclipai/shared/model-catalog";
import { getModelCatalog } from "../services/model-catalog.js";
import { assertAuthenticated } from "./authz.js";

const TOP_MAKERS = new Set<string>(CATALOG_TOP_MAKERS);

export function modelCatalogRoutes(): Router {
  const router = Router();

  // The public model catalog's chat models from the major makers, newest
  // first, for the board's model lists (App Studio, Terminals), which show
  // the newer ones next to their own. Instance-level: public model names,
  // release dates and prices only, no company or user data. Answers at once
  // with what the server has; an old catalog is renewed in the background.
  router.get("/model-catalog", (req, res) => {
    assertAuthenticated(req);
    const catalog = getModelCatalog();
    res.json({
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      models: catalog.models.filter((model) => isCatalogChatModel(model) && TOP_MAKERS.has(model.id.slice(0, model.id.indexOf("/")))),
    } satisfies ModelCatalogSnapshot);
  });

  return router;
}
