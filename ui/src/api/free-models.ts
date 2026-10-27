import type { FreeModelHealthMap, FreeModelUsageSummary, MoanKnowledgeStatus } from "@paperclipai/shared";
import { api } from "./client";

export const freeModelsApi = {
  usage: (companyId: string) =>
    api.get<FreeModelUsageSummary>(`/companies/${encodeURIComponent(companyId)}/free-models/usage`),
  resetUsage: (companyId: string) =>
    api.post<FreeModelUsageSummary>(`/companies/${encodeURIComponent(companyId)}/free-models/usage/reset`, {}),
  /** Each free model's last known state: daily limit (and when it resets), busy, closed by its provider. */
  health: () => api.get<FreeModelHealthMap>("/free-models/health"),
  /** Moan's Jamaican knowledge index: pages, sources, when it last refreshed. */
  moanStatus: () => api.get<MoanKnowledgeStatus>("/free-models/moan/status"),
  moanRefresh: (force = false) =>
    api.post<{ started: boolean; sources: number; status: MoanKnowledgeStatus }>("/free-models/moan/refresh", { force }),
};
