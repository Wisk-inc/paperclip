import type { PuterImageModelId } from "@paperclipai/shared/puter-ai";
import { puterImage } from "@paperclipai/shared/puter-ai";

const MAX_HISTORY_COMMENTS = 40;

export interface ThreadComment {
  id: string;
  authorType?: string | null;
  authorAgentId: string | null;
  body: string;
  presentation?: { kind?: string } | null;
}

export interface ThreadAttachment {
  id: string;
  issueCommentId: string | null;
  contentType: string;
  contentPath: string;
}

export interface IssueSummary {
  title?: string;
  description?: string | null;
  companyId: string;
  conversationAgentId?: string | null;
}

export interface ThreadApi {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  json: <T>(path: string, init?: RequestInit) => Promise<T>;
}

/** The authenticated Automa API for one run: fails loudly so a tool loop never acts on a bad read. */
export function threadApi(apiUrl: string, authToken: string, runId: string, signal?: AbortSignal): ThreadApi {
  const headers = { authorization: `Bearer ${authToken}`, "x-paperclip-run-id": runId };
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal,
    });
    if (!response.ok) throw new Error(`Automa API ${init.method ?? "GET"} ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  return { request, json: async <T>(path: string, init?: RequestInit) => (await request(path, init)).json() as Promise<T> };
}

export interface LoadedThread {
  issue: IssueSummary;
  comments: ThreadComment[];
  lastUser: ThreadComment | null;
}

export async function loadThread(api: ThreadApi, issueId: string, agentId: string): Promise<LoadedThread> {
  const issue = await api.json<IssueSummary>(`/api/issues/${issueId}`);
  // Newest first from the API, so a long chat keeps its latest messages; reversed into reading order.
  const all = (await api.json<ThreadComment[]>(`/api/issues/${issueId}/comments?order=desc&limit=${MAX_HISTORY_COMMENTS * 2}`))
    .reverse()
    .filter((comment) => comment.authorType !== "system" && comment.presentation?.kind !== "system_notice" && comment.body.trim());
  // "/new" starts a fresh session: the chat stays on screen, but the model
  // starts over from the message after it, and never sees the command itself.
  const boundary = all.reduce((found, comment, index) => (comment.authorAgentId !== agentId && comment.body.trim() === "/new" ? index : found), -1);
  const comments = all.slice(boundary + 1).slice(-MAX_HISTORY_COMMENTS);
  const lastUser = [...comments].reverse().find((comment) => comment.authorAgentId !== agentId) ?? null;
  return { issue, comments, lastUser };
}

/** A small JPEG data URL for a comment's images: a vision model times out on full-size photos. */
export async function readCommentPictures(
  api: ThreadApi,
  issueId: string,
  commentId: string,
  limit = 2,
): Promise<string[]> {
  const attachments = await api.json<ThreadAttachment[]>(`/api/issues/${issueId}/attachments`);
  const pictures: string[] = [];
  for (const attachment of attachments) {
    if (attachment.issueCommentId !== commentId || !attachment.contentType.startsWith("image/")) continue;
    const bytes = Buffer.from(await (await api.request(attachment.contentPath)).arrayBuffer());
    pictures.push(await shrinkToDataUrl(bytes, attachment.contentType));
    if (pictures.length >= limit) break;
  }
  return pictures;
}

async function shrinkToDataUrl(bytes: Buffer, contentType: string): Promise<string> {
  try {
    const { default: sharp } = await import("sharp");
    const small = await sharp(bytes).rotate().resize(384, 384, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return `data:image/jpeg;base64,${small.toString("base64")}`;
  } catch {
    if (bytes.length > 1_500_000) throw new Error("This picture is too large to read on this device. Attach a smaller one.");
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  }
}

export interface DrawnImage {
  attachmentId: string;
  contentPath: string;
  markdown: string;
  mimeType: string;
}

/** Draws a picture with an image model, uploads it to the chat, and gives back how to show it. */
export async function drawAndUploadImage(
  api: ThreadApi,
  companyId: string,
  issueId: string,
  runId: string,
  model: PuterImageModelId,
  prompt: string,
  signal?: AbortSignal,
): Promise<DrawnImage> {
  const image = await puterImage(prompt, { model, signal });
  const ext = image.mimeType === "image/jpeg" ? "jpg" : "png";
  const form = new FormData();
  form.append("file", new Blob([image.bytes], { type: image.mimeType }), `automa-${runId.slice(0, 8)}-${Date.now().toString(36)}.${ext}`);
  const attachment = await api.json<{ id: string; contentPath: string }>(
    `/api/companies/${companyId}/issues/${issueId}/attachments`,
    { method: "POST", body: form },
  );
  const alt = prompt.slice(0, 80).replace(/[[\]\n]/g, " ");
  return { attachmentId: attachment.id, contentPath: attachment.contentPath, mimeType: image.mimeType, markdown: `![${alt}](${attachment.contentPath})` };
}

export async function postReply(api: ThreadApi, issueId: string, body: string, attachmentIds?: string[]): Promise<void> {
  await api.json(`/api/issues/${issueId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, ...(attachmentIds && attachmentIds.length ? { attachmentIds } : {}) }),
  });
}
