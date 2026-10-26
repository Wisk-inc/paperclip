import {
  isPuterImageModel,
  puterComplete,
  puterImage,
  PUTER_MODELS,
  type PuterContentPart,
  type PuterMessage,
  type PuterUsage,
} from "@paperclipai/shared/puter-ai";
import type { FreeModelRunUsage } from "@paperclipai/shared";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, buildPaperclipEnv } from "../utils.js";
import { equivalentImageCostUsd, equivalentTokenCostUsd } from "../../services/free-models.js";
import { formatWithThinking, readThinkingLevel, splitThinking, thinkingInstruction } from "./thinking.js";

const MAX_HISTORY_COMMENTS = 40;
const VISION_MODEL = PUTER_MODELS["nemotron-vision"];

interface ThreadComment {
  id: string;
  authorType?: string | null;
  authorAgentId: string | null;
  body: string;
  presentation?: { kind?: string } | null;
}

interface ThreadAttachment {
  id: string;
  issueCommentId: string | null;
  contentType: string;
  contentPath: string;
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A small JPEG data URL: the vision model times out on full-size photos. */
async function visionDataUrl(bytes: Buffer, contentType: string): Promise<string> {
  try {
    const { default: sharp } = await import("sharp");
    const small = await sharp(bytes).rotate().resize(384, 384, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return `data:image/jpeg;base64,${small.toString("base64")}`;
  } catch {
    if (bytes.length > 1_500_000) throw new Error("This picture is too large to read on this device. Attach a smaller one.");
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { agent, config, context, runId, authToken, onLog } = ctx;
  const model = asString(config.model, PUTER_MODELS["deepseek-flash"]);
  const issueId = readId(context.issueId) ?? readId(context.taskId);
  ctx.onDispatch?.();

  if (!issueId) {
    await onLog("stdout", "No conversation on this wake; nothing to answer.\n");
    return { exitCode: 0, signal: null, timedOut: false, provider: "free_models", model, costUsd: 0, summary: "Nothing to answer" };
  }
  if (!authToken) throw new Error("This Automa server has no agent key (PAPERCLIP_AGENT_JWT_SECRET), so the free model cannot post its reply.");

  const apiUrl = buildPaperclipEnv(agent).PAPERCLIP_API_URL;
  const authHeaders = { authorization: `Bearer ${authToken}`, "x-paperclip-run-id": runId };
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { ...authHeaders, ...(init.headers as Record<string, string> | undefined) },
      signal: ctx.signal,
    });
    if (!response.ok) throw new Error(`Automa API ${init.method ?? "GET"} ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  const api = async <T>(path: string, init: RequestInit = {}) => (await request(path, init)).json() as Promise<T>;

  const issue = await api<{ title?: string; description?: string | null; companyId: string; conversationAgentId?: string | null }>(`/api/issues/${issueId}`);
  // Newest first from the API, so a long chat keeps its latest messages; reversed into reading order.
  const comments = (await api<ThreadComment[]>(`/api/issues/${issueId}/comments?order=desc&limit=${MAX_HISTORY_COMMENTS * 2}`))
    .reverse()
    .filter((comment) => comment.authorType !== "system" && comment.presentation?.kind !== "system_notice" && comment.body.trim())
    .slice(-MAX_HISTORY_COMMENTS);
  const lastUser = [...comments].reverse().find((comment) => comment.authorAgentId !== agent.id);
  const isImageModel = isPuterImageModel(model);

  // Pictures attached to the newest message: drawn from (image models) or read (the vision model).
  const pictures: string[] = [];
  if (lastUser && (isImageModel || model === VISION_MODEL)) {
    const attachments = await api<ThreadAttachment[]>(`/api/issues/${issueId}/attachments`);
    for (const attachment of attachments) {
      if (attachment.issueCommentId !== lastUser.id || !attachment.contentType.startsWith("image/")) continue;
      const bytes = Buffer.from(await (await request(attachment.contentPath)).arrayBuffer());
      pictures.push(await visionDataUrl(bytes, attachment.contentType));
      if (pictures.length >= 2) break;
    }
  }

  const spent: Array<{ model: string; usage: PuterUsage }> = [];
  let body: string;
  let attachmentIds: string[] | undefined;
  let answeredBy = model;
  let images = 0;

  if (isImageModel) {
    const request_ = (lastUser?.body ?? issue.description ?? issue.title ?? "").trim();
    let prompt = request_;
    if (pictures.length) {
      await onLog("stdout", "Reading the attached picture\n");
      const described = await puterComplete([{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: pictures[0]! } },
          {
            type: "text",
            text: `Someone attached this picture and asked: "${request_ || "recreate it"}". Write one detailed prompt, under 70 words, for an image generator to draw this picture with that change applied, keeping everything else the same. Reply with the prompt only.`,
          },
        ],
      }], { model: VISION_MODEL, signal: ctx.signal });
      spent.push({ model: described.model, usage: described.usage });
      prompt = described.text.replace(/^["'\s]+|["'\s]+$/g, "");
    }
    if (!prompt) throw new Error("Nothing to draw yet. Describe a picture, or attach one with the change you want.");
    await onLog("stdout", `Drawing with ${model}\n`);
    const image = await puterImage(prompt, { model, signal: ctx.signal });
    images = 1;
    const ext = image.mimeType === "image/jpeg" ? "jpg" : "png";
    const form = new FormData();
    form.append("file", new Blob([image.bytes], { type: image.mimeType }), `automa-${runId.slice(0, 8)}.${ext}`);
    const attachment = await api<{ id: string; contentPath: string }>(
      `/api/companies/${issue.companyId}/issues/${issueId}/attachments`,
      { method: "POST", body: form },
    );
    attachmentIds = [attachment.id];
    const alt = prompt.slice(0, 80).replace(/[[\]\n]/g, " ");
    body = pictures.length
      ? `![${alt}](${attachment.contentPath})\n\n_Redrawn from your picture: ${prompt}_`
      : `![${alt}](${attachment.contentPath})`;
  } else {
    const level = readThinkingLevel(config.effort);
    const messages: PuterMessage[] = [{
      role: "system",
      content: `You are ${agent.name}, an agent in an Automa company. Answer the person helpfully in Markdown.`,
    }];
    if (!issue.conversationAgentId) {
      messages.push({ role: "user", content: `Task: ${issue.title ?? ""}\n\n${issue.description ?? ""}`.trim() });
    }
    for (const comment of comments) {
      const role = comment.authorAgentId === agent.id ? "assistant" : "user";
      // The level rides on the newest message, where models follow it even when earlier replies had no thinking.
      const text = comment === lastUser && level ? `${comment.body}\n\n(${thinkingInstruction(level)})` : comment.body;
      if (comment === lastUser && pictures.length) {
        const parts: PuterContentPart[] = pictures.map((url) => ({ type: "image_url", image_url: { url } }));
        parts.push({ type: "text", text });
        messages.push({ role, content: parts });
      } else {
        messages.push({ role, content: text });
      }
    }
    if (messages.length === 1) throw new Error("Nothing to answer: the conversation is empty");
    await onLog("stdout", `Asking ${model}${level ? ` (thinking: ${level})` : ""}\n`);
    const reply = await puterComplete(messages, { model, signal: ctx.signal });
    spent.push({ model: reply.model, usage: reply.usage });
    answeredBy = reply.model;
    const { thinking, answer } = splitThinking(reply.text, reply.reasoning);
    if (thinking) await onLog("stdout", `${JSON.stringify({ type: "thinking", text: thinking })}\n`);
    const shown = level ? formatWithThinking(thinking, answer) : answer;
    body = reply.model === model ? shown : `${shown}\n\n_${model} was busy, so ${reply.model} answered._`;
  }

  await api(`/api/issues/${issueId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, ...(attachmentIds ? { attachmentIds } : {}) }),
  });

  const inputTokens = spent.reduce((sum, part) => sum + part.usage.inputTokens, 0);
  const outputTokens = spent.reduce((sum, part) => sum + part.usage.outputTokens, 0);
  const tokenCost = (await Promise.all(spent.map((part) => equivalentTokenCostUsd(part.model, part.usage)))).reduce((a, b) => a + b, 0);
  const freeUsage: FreeModelRunUsage = {
    model: answeredBy,
    inputTokens,
    outputTokens,
    images,
    equivalentUsd: tokenCost + equivalentImageCostUsd(images),
  };
  await onLog("stdout", `Replied with ${answeredBy}: ${inputTokens + outputTokens} tokens${images ? `, ${images} image` : ""}, free (≈ $${freeUsage.equivalentUsd.toPrecision(2)} at paid prices)\n`);

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "free_models",
    biller: "free_models",
    model: answeredBy,
    costUsd: 0,
    usage: { inputTokens, outputTokens },
    usageBasis: "per_run",
    resultJson: { freeUsage },
    summary: body.slice(0, 280),
  };
}
