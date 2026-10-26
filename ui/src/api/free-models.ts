import type { FreeModelUsageSummary } from "@paperclipai/shared";
import { api } from "./client";

export const freeModelsApi = {
  usage: (companyId: string) =>
    api.get<FreeModelUsageSummary>(`/companies/${encodeURIComponent(companyId)}/free-models/usage`),
  resetUsage: (companyId: string) =>
    api.post<FreeModelUsageSummary>(`/companies/${encodeURIComponent(companyId)}/free-models/usage/reset`, {}),
};
