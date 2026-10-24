import type { TerminalSessionSummary, TerminalSessionMode, TerminalStatus, TerminalToolId } from "@paperclipai/shared";
import { api } from "./client";

export const terminalsApi = {
  status: (companyId: string) =>
    api.get<TerminalStatus>(`/companies/${companyId}/terminals/status`, { cache: "no-store" }),
  sessions: (companyId: string) =>
    api.get<{ sessions: TerminalSessionSummary[] }>(`/companies/${companyId}/terminals/sessions`, { cache: "no-store" }),
  start: (
    companyId: string,
    input: { toolId: TerminalToolId; mode: TerminalSessionMode; cols: number; rows: number; cwd?: string; agentId?: string },
  ) => api.post<{ session: TerminalSessionSummary }>(`/companies/${companyId}/terminals/sessions`, input),
  stop: (companyId: string, id: string) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/terminals/sessions/${id}/stop`, {}),
  /** The same-origin WS path for a session's live stream. */
  wsPath: (companyId: string, id: string) =>
    `/api/companies/${encodeURIComponent(companyId)}/terminals/sessions/${encodeURIComponent(id)}/ws`,
};
