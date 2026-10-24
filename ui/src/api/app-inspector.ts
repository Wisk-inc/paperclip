import { api } from "./client";

export interface InspectorProjectView {
  id: string;
  label: string;
  status: "decoding" | "ready" | "building" | "built" | "failed";
  outputPath: string | null;
  error: string | null;
  createdAt: string;
  logTail: string;
}
export interface InspectorStatusView {
  kind: "phone" | "computer";
  apktoolReady: boolean;
  apps: string[];
}
export interface InspectorFileNode {
  name: string;
  path: string;
  dir: boolean;
}
type Source = { kind: "installed"; package: string } | { kind: "path"; apkPath: string };

const root = (companyId: string) => `/companies/${companyId}/app-inspector`;

export const appInspectorApi = {
  status: (companyId: string) => api.get<InspectorStatusView>(`${root(companyId)}/status`, { cache: "no-store" }),
  projects: (companyId: string) => api.get<{ projects: InspectorProjectView[] }>(`${root(companyId)}/projects`, { cache: "no-store" }),
  open: (companyId: string, input: { source: Source; label?: string }) =>
    api.post<{ project: InspectorProjectView }>(`${root(companyId)}/projects`, input),
  project: (companyId: string, id: string) => api.get<{ project: InspectorProjectView }>(`${root(companyId)}/projects/${id}`, { cache: "no-store" }),
  dir: (companyId: string, id: string, path: string) =>
    api.get<{ entries: InspectorFileNode[] }>(`${root(companyId)}/projects/${id}/dir?path=${encodeURIComponent(path)}`, { cache: "no-store" }),
  file: (companyId: string, id: string, path: string) =>
    api.get<{ text: string; truncated: boolean }>(`${root(companyId)}/projects/${id}/file?path=${encodeURIComponent(path)}`, { cache: "no-store" }),
  writeFile: (companyId: string, id: string, path: string, text: string) =>
    api.put<{ ok: true }>(`${root(companyId)}/projects/${id}/file`, { path, text }),
  rebuild: (companyId: string, id: string) => api.post<{ project: InspectorProjectView }>(`${root(companyId)}/projects/${id}/rebuild`, {}),
  explain: (companyId: string, id: string, path: string) =>
    api.post<{ explanation: string }>(`${root(companyId)}/projects/${id}/explain`, { path }),
  remove: (companyId: string, id: string) => api.delete<{ ok: boolean }>(`${root(companyId)}/projects/${id}`),
};
