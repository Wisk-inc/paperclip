import type { FreeModelUsageSummary, MoanKnowledgeStatus } from "@paperclipai/shared";
import { api } from "./client";

export const freeModelsApi = {
  usage: (companyId: string) =>
    api.get<FreeModelUsageSummary>(`/companies/${encodeURIComponent(companyId)}/free-models/usage`),
  resetUsage: (companyId: string) =>
    api.post<FreeModelUsageSummary>(`/companies/${encodeURIComponent(companyId)}/free-models/usage/reset`, {}),
  /** Moan's Jamaican knowledge index: pages, sources, when it last refreshed. */
  moanStatus: () => api.get<MoanKnowledgeStatus>("/free-models/moan/status"),
  moanRefresh: (force = false) =>
    api.post<{ started: boolean; sources: number; status: MoanKnowledgeStatus }>("/free-models/moan/refresh", { force }),
};
