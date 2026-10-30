import type {
  StudioTeammate,
  StudioAiKeyStatus,
  StudioAiProvider,
  StudioAssistantTurn,
  StudioChangeFile,
  StudioCheckpoint,
  StudioChangeRequest,
  StudioCollaborator,
  StudioConsoleLine,
  StudioFileContent,
  StudioFileNode,
  StudioLanguage,
  StudioLanguageCategory,
  StudioMessage,
  StudioPageReport,
  StudioParticipant,
  StudioRunState,
  StudioToolchainStatus,
  StudioUsageSummary,
  StudioWorkspace,
  StudioAssistantAttachmentInput,
  StudioThinkingLevel,
} from "@paperclipai/shared";
import { buildSameOriginWebSocketUrl } from "../lib/websocket-url";
import { api, ApiError } from "./client";

/** A catalog entry as the server lists it: starter file names, not contents. */
export type StudioCatalogLanguage = Omit<StudioLanguage, "files"> & { starterFiles?: string[] };

export interface StudioCatalog {
  platform: StudioToolchainStatus["platform"];
  categories: ReadonlyArray<{ id: StudioLanguageCategory; label: string }>;
  languages: StudioCatalogLanguage[];
  toolchains: StudioToolchainStatus[];
  cloudflared: boolean;
}

export interface StudioWorkspaceSummary extends StudioWorkspace {
  run: StudioRunState | null;
}

export interface StudioWorkspaceDetail {
  workspace: StudioWorkspaceSummary | null;
  run: StudioRunState;
  runCommand: string | null;
  toolchain: StudioToolchainStatus | null;
  participants: StudioParticipant[];
  assistantRunning: boolean;
}

export interface StudioExecResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export interface StudioShareResult {
  workspace: StudioWorkspace;
  code: string;
  inviteUrl: string | null;
  localInviteUrl: string;
  publicError: string | null;
}

const ws = (id: string) => `/studio/workspaces/${encodeURIComponent(id)}`;
const company = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/studio`;
const pathQuery = (path: string) => `path=${encodeURIComponent(path)}`;

export const studioApi = {
  catalog: (companyId: string, refresh = false) =>
    api.get<StudioCatalog>(`${company(companyId)}/languages${refresh ? "?refresh=1" : ""}`),
  list: (companyId: string) => api.get<{ workspaces: StudioWorkspaceSummary[] }>(`${company(companyId)}/workspaces`),
  create: (companyId: string, input: { name: string; language: string; description?: string | null; gitUrl?: string | null }) =>
    api.post<{ workspace: StudioWorkspace; toolchain: StudioToolchainStatus | null }>(`${company(companyId)}/workspaces`, input),
  get: (id: string) => api.get<StudioWorkspaceDetail>(ws(id)),
  update: (id: string, input: { name?: string; description?: string | null; runCommand?: string | null }) =>
    api.patch<{ workspace: StudioWorkspace }>(ws(id), input),
  remove: (id: string) => api.delete<{ ok: true }>(ws(id)),

  tree: (id: string) => api.get<{ tree: StudioFileNode[] }>(`${ws(id)}/tree`),
  readFile: (id: string, path: string) => api.get<StudioFileContent>(`${ws(id)}/file?${pathQuery(path)}`, { cache: "no-store" }),
  writeFile: (id: string, input: { path: string; content: string; baseVersion?: string | null }) =>
    api.put<StudioFileContent>(`${ws(id)}/file`, input),
  createEntry: (id: string, input: { path: string; type: "file" | "folder" }) =>
    api.post<{ ok: true; path: string }>(`${ws(id)}/entries`, input),
  move: (id: string, input: { from: string; to: string }) => api.post<{ ok: true }>(`${ws(id)}/move`, input),
  deleteEntry: (id: string, path: string) => api.delete<{ ok: true }>(`${ws(id)}/entries?${pathQuery(path)}`),
  upload: (id: string, files: File[], folder: string | null) => {
    const form = new FormData();
    if (folder) form.append("folder", folder);
    for (const file of files) form.append("files", file, file.name);
    return api.postForm<{ paths: string[] }>(`${ws(id)}/upload`, form);
  },
  downloadUrl: (id: string, path: string) => `/api${ws(id)}/download?${pathQuery(path)}`,
  /** A zip of the whole project, or of one folder in it. */
  archiveUrl: (id: string, path?: string | null) => `/api${ws(id)}/archive${path ? `?${pathQuery(path)}` : ""}`,
  /** A project file to show inline (images, audio, video, fonts). */
  rawUrl: (id: string, path: string, version?: string | number) => `/api${ws(id)}/raw?${pathQuery(path)}${version ? `&v=${encodeURIComponent(String(version))}` : ""}`,

  checkpoints: (id: string) => api.get<{ checkpoints: StudioCheckpoint[] }>(`${ws(id)}/checkpoints`, { cache: "no-store" }),
  saveCheckpoint: (id: string, label?: string | null) => api.post<{ checkpoint: StudioCheckpoint }>(`${ws(id)}/checkpoints`, { label: label ?? null }),
  restoreCheckpoint: (id: string, checkpointId: string) =>
    api.post<{ restored: StudioCheckpoint; safety: StudioCheckpoint }>(`${ws(id)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`, {}),
  deleteCheckpoint: (id: string, checkpointId: string) => api.delete<{ ok: true }>(`${ws(id)}/checkpoints/${encodeURIComponent(checkpointId)}`),

  complete: (id: string, input: { path: string; prefix: string; suffix: string; provider: StudioAiProvider; model?: string | null }, signal?: AbortSignal) =>
    api.post<{ completion: string; model: string; error?: string }>(`${ws(id)}/complete`, input, { signal }),

  run: (id: string, command?: string | null) => api.post<{ run: StudioRunState }>(`${ws(id)}/run`, { command: command ?? null }),
  stop: (id: string) => api.post<{ run: StudioRunState }>(`${ws(id)}/stop`, {}),
  console: (id: string, after = 0) => api.get<{ lines: StudioConsoleLine[] }>(`${ws(id)}/console?after=${after}`, { cache: "no-store" }),
  clearConsole: (id: string) => api.delete<{ ok: true }>(`${ws(id)}/console`),
  consoleInput: (id: string, text: string) => api.post<{ ok: true }>(`${ws(id)}/console/input`, { text }),
  exec: (id: string, command: string) => api.post<StudioExecResult>(`${ws(id)}/exec`, { command }),
  installToolchain: (id: string) =>
    api.post<StudioExecResult & { toolchain: StudioToolchainStatus }>(`${ws(id)}/install-toolchain`, {}),
  openPublicLink: (id: string) => api.post<{ run: StudioRunState }>(`${ws(id)}/public-link`, {}),
  closePublicLink: (id: string) => api.delete<{ run: StudioRunState }>(`${ws(id)}/public-link`),
  installCloudflared: (companyId: string) =>
    api.post<{ ok: boolean; message: string; log: string[] }>(`${company(companyId)}/cloudflared`, {}),

  share: (id: string, options: { publicLink?: boolean; expiresInHours?: number | null; newCode?: boolean } = {}) =>
    api.post<StudioShareResult>(`${ws(id)}/share`, {
      public: options.publicLink ?? true,
      ...(options.expiresInHours !== undefined ? { expiresInHours: options.expiresInHours } : {}),
      ...(options.newCode ? { newCode: true } : {}),
    }),
  stopSharing: (id: string) => api.delete<{ workspace: StudioWorkspace }>(`${ws(id)}/share`),
  collaborators: (id: string) =>
    api.get<{ collaborators: StudioCollaborator[]; participants: StudioParticipant[] }>(`${ws(id)}/collaborators`),
  removeCollaborator: (id: string, collaboratorId: string) =>
    api.delete<{ collaborator: StudioCollaborator }>(`${ws(id)}/collaborators/${encodeURIComponent(collaboratorId)}`),

  messages: (id: string) => api.get<{ messages: StudioMessage[] }>(`${ws(id)}/messages`, { cache: "no-store" }),
  postMessage: (id: string, body: string, file?: File | null) => {
    const form = new FormData();
    form.append("body", body);
    if (file) form.append("file", file, file.name);
    return api.postForm<{ message: StudioMessage }>(`${ws(id)}/messages`, form);
  },
  sharedFileUrl: (id: string, attachmentId: string) => `/api${ws(id)}/shared/${encodeURIComponent(attachmentId)}`,
  addSharedFile: (id: string, attachmentId: string, folder?: string | null) =>
    api.post<{ path: string }>(`${ws(id)}/shared/${encodeURIComponent(attachmentId)}/add`, { folder: folder ?? null }),

  changes: (id: string) => api.get<{ changeRequests: StudioChangeRequest[] }>(`${ws(id)}/changes`, { cache: "no-store" }),
  acceptChange: (id: string, changeId: string, files?: StudioChangeFile[]) =>
    api.post<{ changeRequest: StudioChangeRequest }>(`${ws(id)}/changes/${encodeURIComponent(changeId)}/accept`, files ? { files } : {}),
  rejectChange: (id: string, changeId: string) =>
    api.post<{ changeRequest: StudioChangeRequest }>(`${ws(id)}/changes/${encodeURIComponent(changeId)}/reject`, {}),

  aiKeys: (companyId: string) => api.get<{ keys: StudioAiKeyStatus[] }>(`${company(companyId)}/ai-keys`),
  /** What each model did for App Studio over the last `days` (30 by default). */
  usage: (companyId: string, days = 30) => api.get<StudioUsageSummary>(`${company(companyId)}/usage?days=${days}`),
  saveAiKey: (companyId: string, input: { provider: StudioAiProvider; apiKey: string; baseUrl?: string | null }) =>
    api.put<{ key: StudioAiKeyStatus }>(`${company(companyId)}/ai-keys`, input),
  deleteAiKey: (companyId: string, provider: StudioAiProvider) =>
    api.delete<{ ok: true }>(`${company(companyId)}/ai-keys/${encodeURIComponent(provider)}`),
  assistant: (id: string) => api.get<{ turns: StudioAssistantTurn[]; running: boolean }>(`${ws(id)}/assistant`, { cache: "no-store" }),
  askAssistant: (
    id: string,
    input: { message: string; provider: StudioAiProvider; model: string; attachments?: StudioAssistantAttachmentInput[]; thinking?: StudioThinkingLevel; team?: StudioTeammate[] },
  ) =>
    api.post<{ turn: StudioAssistantTurn }>(`${ws(id)}/assistant`, input),
  stopAssistant: (id: string) => api.post<{ ok: true }>(`${ws(id)}/assistant/stop`, {}),
  /** How the page rendered here, for the agent that asked to see it (view_app). */
  previewReport: (id: string, requestId: string, report: StudioPageReport) =>
    api.post<{ ok: true; delivered: boolean }>(`${ws(id)}/preview-report`, { requestId, report }),
  /** Reverses one file change the assistant made. */
  undoEdit: (id: string, editId: string) =>
    api.post<{ path: string; undoId: string }>(`${ws(id)}/edits/${encodeURIComponent(editId)}/undo`, {}),
  clearAssistant: (id: string) => api.delete<{ ok: true }>(`${ws(id)}/assistant`),
};

// ── Collaborators (guests) ─────────────────────────────────────────────────
// Guests use their own token, never the owner's session, so these calls go
// through fetch directly with the x-studio-guest header.

export interface StudioGuestSession {
  token: string;
  collaborator: StudioCollaborator;
  workspace: { id: string; name: string; language: string };
}

async function guestRequest<T>(token: string | null, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("x-studio-guest", token);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const res = await fetch(`/api/studio-guest${path}`, { ...init, headers, credentials: "omit" });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

export const studioGuestApi = {
  join: (code: string, name: string) =>
    guestRequest<StudioGuestSession>(null, "/join", { method: "POST", body: JSON.stringify({ code, name }) }),
  workspace: (token: string) =>
    guestRequest<{ workspace: { id: string; name: string; language: string }; you: StudioParticipant; participants: StudioParticipant[]; run: StudioRunState | null }>(token, "/workspace"),
  tree: (token: string) => guestRequest<{ tree: StudioFileNode[] }>(token, "/tree"),
  readFile: (token: string, path: string) => guestRequest<StudioFileContent>(token, `/file?${pathQuery(path)}`),
  console: (token: string, after = 0) => guestRequest<{ lines: StudioConsoleLine[] }>(token, `/console?after=${after}`),
  messages: (token: string) => guestRequest<{ messages: StudioMessage[] }>(token, "/messages"),
  postMessage: (token: string, body: string, file?: File | null) => {
    const form = new FormData();
    form.append("body", body);
    if (file) form.append("file", file, file.name);
    return guestRequest<{ message: StudioMessage }>(token, "/messages", { method: "POST", body: form });
  },
  sharedFileUrl: (token: string, attachmentId: string) =>
    `/api/studio-guest/shared/${encodeURIComponent(attachmentId)}?token=${encodeURIComponent(token)}`,
  rawUrl: (token: string, path: string) => `/api/studio-guest/raw?${pathQuery(path)}&token=${encodeURIComponent(token)}`,
  archiveUrl: (token: string, path?: string | null) =>
    `/api/studio-guest/archive?${path ? `${pathQuery(path)}&` : ""}token=${encodeURIComponent(token)}`,
  changes: (token: string) => guestRequest<{ changeRequests: StudioChangeRequest[] }>(token, "/changes"),
  submitChange: (token: string, input: { message?: string | null; files: Array<{ path: string; after: string | null }> }) =>
    guestRequest<{ changeRequest: StudioChangeRequest }>(token, "/changes", { method: "POST", body: JSON.stringify(input) }),
};

/** The live socket URL for the owner's IDE or a collaborator. */
export function studioSocketUrl(target: { workspaceId: string } | { guestToken: string }): string {
  return buildSameOriginWebSocketUrl(
    "guestToken" in target
      ? `/api/studio-guest/ws?token=${encodeURIComponent(target.guestToken)}`
      : `/api/studio/workspaces/${encodeURIComponent(target.workspaceId)}/ws`,
  );
}
