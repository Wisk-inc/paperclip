import { api } from "./client";

export type InspectorView = "files" | "java";
export interface InspectorDecodeOptions {
  resources: boolean;
  sources: boolean;
  java: boolean;
}
export interface InspectorProjectView {
  id: string;
  label: string;
  packageName: string | null;
  splitCount: number;
  options: InspectorDecodeOptions;
  status: "decoding" | "ready" | "building" | "built" | "failed";
  /** The apktool tree exists (true even after a failed rebuild). */
  decoded: boolean;
  java: "none" | "working" | "ready" | "failed";
  hasOutput: boolean;
  outputName: string | null;
  /** Where the rebuild was copied, when the device's Downloads folder was writable. */
  downloadsPath: string | null;
  error: string | null;
  createdAt: string;
  logTail: string;
}
export interface InspectorStatusView {
  kind: "phone" | "computer";
  apktoolReady: boolean;
  jadxReady: boolean;
  /** Package names from `pm` (browsers outside the Automa app); often empty. */
  apps: string[];
}
export interface InspectorFileNode {
  name: string;
  path: string;
  dir: boolean;
  size: number | null;
}
export interface InspectorFileContent {
  text: string;
  truncated: boolean;
  binary: boolean;
  readOnly: boolean;
}
interface OpenExtras {
  label?: string;
  packageName?: string;
  splitCount?: number;
  options?: InspectorDecodeOptions;
}
export interface InspectorSearchHit {
  path: string;
  dir: boolean;
  line: number | null;
  preview: string | null;
}
export interface InspectorAppInfo {
  packageName: string | null;
  label: string | null;
  versionName: string | null;
  versionCode: string | null;
  minSdk: string | null;
  targetSdk: string | null;
  iconPath: string | null;
  launcherActivity: string | null;
  debuggable: boolean;
  permissions: string[];
  activities: string[];
  services: string[];
  receivers: string[];
  providers: string[];
}
type Source = { kind: "installed"; package: string } | { kind: "path"; apkPath: string };

const root = (companyId: string) => `/companies/${companyId}/app-inspector`;

export const appInspectorApi = {
  status: (companyId: string) => api.get<InspectorStatusView>(`${root(companyId)}/status`, { cache: "no-store" }),
  projects: (companyId: string) => api.get<{ projects: InspectorProjectView[] }>(`${root(companyId)}/projects`, { cache: "no-store" }),
  open: (companyId: string, input: { source: Source } & OpenExtras) =>
    api.post<{ project: InspectorProjectView }>(`${root(companyId)}/projects`, input),
  /** Send the APK itself (an app read on the phone, or a chosen file). */
  upload: (companyId: string, apk: Blob, extras: OpenExtras) => {
    const query = new URLSearchParams();
    if (extras.label) query.set("label", extras.label);
    if (extras.packageName) query.set("package", extras.packageName);
    if (extras.splitCount) query.set("splits", String(extras.splitCount));
    if (extras.options) {
      query.set("res", extras.options.resources ? "1" : "0");
      query.set("src", extras.options.sources ? "1" : "0");
      query.set("java", extras.options.java ? "1" : "0");
    }
    return api.putRaw<{ project: InspectorProjectView }>(`${root(companyId)}/uploads?${query.toString()}`, apk);
  },
  project: (companyId: string, id: string) => api.get<{ project: InspectorProjectView }>(`${root(companyId)}/projects/${id}`, { cache: "no-store" }),
  dir: (companyId: string, id: string, path: string, view: InspectorView) =>
    api.get<{ entries: InspectorFileNode[] }>(`${root(companyId)}/projects/${id}/dir?view=${view}&path=${encodeURIComponent(path)}`, { cache: "no-store" }),
  file: (companyId: string, id: string, path: string, view: InspectorView) =>
    api.get<InspectorFileContent>(`${root(companyId)}/projects/${id}/file?view=${view}&path=${encodeURIComponent(path)}`, { cache: "no-store" }),
  writeFile: (companyId: string, id: string, path: string, text: string) =>
    api.put<{ ok: true }>(`${root(companyId)}/projects/${id}/file`, { path, text }),
  rebuild: (companyId: string, id: string) => api.post<{ project: InspectorProjectView }>(`${root(companyId)}/projects/${id}/rebuild`, {}),
  explain: (companyId: string, id: string, path: string, view: InspectorView) =>
    api.post<{ explanation: string }>(`${root(companyId)}/projects/${id}/explain`, { path, view }),
  search: (companyId: string, id: string, view: InspectorView, q: string, mode: "name" | "text") =>
    api.get<{ results: InspectorSearchHit[]; truncated: boolean }>(
      `${root(companyId)}/projects/${id}/search?view=${view}&mode=${mode}&q=${encodeURIComponent(q)}`,
      { cache: "no-store" },
    ),
  info: (companyId: string, id: string) => api.get<{ info: InspectorAppInfo }>(`${root(companyId)}/projects/${id}/info`, { cache: "no-store" }),
  /** Same-origin URL of an image in the project, for thumbnails. */
  imageUrl: (companyId: string, id: string, view: InspectorView, path: string) =>
    `/api${root(companyId)}/projects/${id}/image?view=${view}&path=${encodeURIComponent(path)}`,
  /** Same-origin URL of the rebuilt APK; the Automa app saves it to Downloads. */
  outputUrl: (companyId: string, id: string) => `/api${root(companyId)}/projects/${id}/output`,
  remove: (companyId: string, id: string) => api.delete<{ ok: boolean }>(`${root(companyId)}/projects/${id}`),
};
