import type { ModelCatalogSnapshot } from "@paperclipai/shared/model-catalog";
import { api } from "./client";

export const modelCatalogApi = {
  /**
   * The public model catalog's chat models from the major makers, newest
   * first. The server keeps it up to date in the background (twice a day at
   * most) and keeps a copy, so this answers at once, also offline.
   */
  get: () => api.get<ModelCatalogSnapshot>("/model-catalog"),
};
