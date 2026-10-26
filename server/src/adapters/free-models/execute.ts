import {
  isPuterImageModel,
  puterComplete,
  puterStream,
  PUTER_IMAGE_MODELS,
  PUTER_MODELS,
  PuterHttpError,
  type PuterContentPart,
  type PuterImageModelId,
  type PuterMessage,
  type PuterToolCall,
  type PuterUsage,
} from "@paperclipai/shared/puter-ai";
import type { FreeModelRunUsage } from "@paperclipai/shared";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asNumber, asString, buildPaperclipEnv } from "../utils.js";
import { equivalentImageCostUsd, equivalentTokenCostUsd } from "../../services/free-models.js";
import { createThinkingTagSplitter, readThinkingLevel, splitThinking, thinkingInstruction } from "./thinking.js";
import { freeToolDefinitions, runFreeTool, type FreeToolContext, type FreeToolToggles } from "./tools.js";
import { drawAndUploadImage, loadThread, postReply, readCommentPictures, threadApi, type ThreadApi } from "./thread.js";
import { freeDirectToolRuntime } from "./direct-runtime.js";

const VISION_MODEL = PUTER_MODELS["nemotron-vision"];
const DEFAULT_MAX_TOOL_TURNS = 24;

function readId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boolToggle(value: unknown, fallback: boolean): boolean {
  if (value === false || value === "off" || value === "false" || value === "none") return false;
  if (value === true || value === "on" || value === "true") return true;
  return fallback;
}

/** The paired image model for a chat model, when one is set and valid. */
function bondedImageModel(config: Record<string, unknown>): PuterImageModelId | null {
  const raw = asString(config.imageModel, "").trim();
  if (!raw) return null;
  if (raw in PUTER_IMAGE_MODELS) return PUTER_IMAGE_MODELS[raw as keyof typeof PUTER_IMAGE_MODELS];
  return isPuterImageModel(raw) ? raw : null;
}

function readToggles(config: Record<string, unknown>, imageModel: PuterImageModelId | null): FreeToolToggles {
  return {
    filesAndCommands: boolToggle(config.freeFiles, true),
    teammatesAndTasks: boolToggle(config.freeTeammates, true),
    web: boolToggle(config.freeWeb, true),
    connections: boolToggle(config.freeConnections, true),
    imageModel,
  };
}

function logLine(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

interface TurnTotals {
  model: string;
  input: number;
  output: number;
}

function sumUsage(spent: TurnTotals[]): PuterUsage {
  return {
    inputTokens: spent.reduce((total, part) => total + part.input, 0),
    outputTokens: spent.reduce((total, part) => total + part.output, 0),
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { agent, config, context, runId, authToken, onLog } = ctx;
  const model = asString(config.model, PUTER_MODELS["deepseek-flash"]);
  const issueId = readId(context.issueId) ?? readId(context.taskId);
  ctx.onDispatch?.();

  if (!issueId) {
    await onLog("stdout", "[paperclip] No conversation on this wake; nothing to answer.\n");
    return { exitCode: 0, signal: null, timedOut: false, provider: "free_models", model, costUsd: 0, summary: null };
  }
  if (!authToken) throw new Error("This Automa server has no agent key (PAPERCLIP_AGENT_JWT_SECRET), so the free model cannot post its reply.");

  const apiUrl = buildPaperclipEnv(agent).PAPERCLIP_API_URL;
  const api = threadApi(apiUrl, authToken, runId, ctx.signal);
  const { issue, comments, lastUser } = await loadThread(api, issueId, agent.id);

  const spent: TurnTotals[] = [];
  const addUsage = (usageModel: string, usage: PuterUsage) => spent.push({ model: usageModel, input: usage.inputTokens, output: usage.outputTokens });

  // The chosen model is itself an image model: draw a picture, no chat loop.
  if (isPuterImageModel(model)) {
    await runImageOnly(ctx, api, issue, lastUser, model, issueId, addUsage);
    return finish(ctx, 1, model, spent);
  }

  const imageModel = bondedImageModel(config);
  const toggles = readToggles(config, imageModel);
  const level = readThinkingLevel(config.effort);
  const direct = toggles.filesAndCommands || toggles.teammatesAndTasks ? freeDirectToolRuntime(ctx) : null;

  // Images drawn by the GenerateImage tool during the run, added to the reply.
  const drawn: { markdown: string; attachmentId: string }[] = [];
  const toolCtx: FreeToolContext = {
    toggles,
    direct,
    runtimeTools: ctx.runtimeTools,
    signal: ctx.signal,
    generateImage: async (prompt) => {
      await onLog("stdout", logLine({ type: "acpx.status", message: `Drawing with ${imageModel}` }));
      const image = await drawAndUploadImage(api, issue.companyId, issueId, runId, imageModel!, prompt, ctx.signal);
      drawn.push({ markdown: image.markdown, attachmentId: image.attachmentId });
      addUsage(imageModel!, { inputTokens: 0, outputTokens: 0 });
      return { markdown: image.markdown, attachmentId: image.attachmentId };
    },
  };
  const tools = freeToolDefinitions(toolCtx);

  // Only the vision model reads attached photos; other chat models are told they can't.
  const pictures = lastUser && model === VISION_MODEL ? await readCommentPictures(api, issueId, lastUser.id) : [];
  const messages = buildMessages({ agentName: agent.name, issue, comments, lastUser, level, pictures, hasTools: tools.length > 0 });
  if (messages.length <= 1) throw new Error("Nothing to answer: the conversation is empty");

  await onLog("stdout", logLine({ type: "acpx.session", agent: "free-models", mode: model, permissionMode: tools.length ? "free, with tools" : "free", sessionId: runId }));

  const { answer, answeredBy, stopReason, hitTurnLimit } = await runToolLoop({
    ctx, model, messages, tools, toolCtx, level, onLog, addUsage,
    maxTurns: Math.max(1, asNumber(config.maxTurnsPerRun, 0) || DEFAULT_MAX_TOOL_TURNS),
  });

  const imageMarkdown = drawn.filter((image) => !answer.includes(image.attachmentId)).map((image) => image.markdown).join("\n\n");
  const note = hitTurnLimit ? "\n\n(Stopped after the tool-use limit. Ask me to continue.)" : "";
  // Thinking streams into the collapsible panel live, never into the reply.
  const body = [answer, imageMarkdown].filter(Boolean).join("\n\n")
    + (answeredBy !== model ? `\n\n_${model} was busy, so ${answeredBy} answered._` : "")
    + note;

  await postReply(api, issueId, body.trim() || "(No reply came back. Send the message again.)", drawn.map((image) => image.attachmentId));
  await onLog("stdout", logLine({ type: "acpx.result", summary: answer ? "Replied" : stopReason, stopReason, inputTokens: sumUsage(spent).inputTokens, outputTokens: sumUsage(spent).outputTokens, costUsd: 0 }));
  return finish(ctx, drawn.length, answeredBy, spent, body);
}

interface BuildInput {
  agentName: string;
  issue: { title?: string; description?: string | null; conversationAgentId?: string | null };
  comments: Array<{ id: string; authorAgentId: string | null; body: string }>;
  lastUser: { id: string } | null;
  level: ReturnType<typeof readThinkingLevel>;
  pictures: string[];
  hasTools: boolean;
}

function systemPrompt(agentName: string, hasTools: boolean, level: ReturnType<typeof readThinkingLevel>): string {
  return [
    `You are ${agentName}, an AI agent on the person's team in Automa, chatting with them in the app.`,
    hasTools
      ? "You have tools and you use them to get real answers and do real work: read and search the web, read and change files, run commands, call the Automa API as yourself (talk to teammates, create and update tasks, write plans), use the person's connected apps, and draw pictures. Prefer finding the real answer with a tool over guessing. When you say you did something, a tool must actually have done it."
      : "Answer in text only in this reply.",
    "Write the way you would to a teammate: answer first, then the detail that matters, in Markdown.",
    level ? thinkingInstruction(level) : "",
  ].filter(Boolean).join("\n\n");
}

function buildMessages(input: BuildInput): PuterMessage[] {
  const messages: PuterMessage[] = [{ role: "system", content: systemPrompt(input.agentName, input.hasTools, input.level) }];
  if (!input.issue.conversationAgentId) {
    const task = `Task: ${input.issue.title ?? ""}\n\n${input.issue.description ?? ""}`.trim();
    if (task) messages.push({ role: "user", content: task });
  }
  for (const comment of input.comments) {
    const role = comment.authorAgentId ? "assistant" : "user";
    const isLast = input.lastUser && comment.id === input.lastUser.id;
    let text = comment.body;
    if (isLast && input.level) text = `${text}\n\n(${thinkingInstruction(input.level)})`;
    if (isLast && input.pictures.length) {
      const parts: PuterContentPart[] = input.pictures.map((url) => ({ type: "image_url", image_url: { url } }));
      parts.push({ type: "text", text });
      messages.push({ role, content: parts });
    } else {
      messages.push({ role, content: text });
    }
  }
  return messages;
}

interface LoopInput {
  ctx: AdapterExecutionContext;
  model: string;
  messages: PuterMessage[];
  tools: ReturnType<typeof freeToolDefinitions>;
  toolCtx: FreeToolContext;
  level: ReturnType<typeof readThinkingLevel>;
  maxTurns: number;
  onLog: AdapterExecutionContext["onLog"];
  addUsage: (model: string, usage: PuterUsage) => void;
}

async function runToolLoop(input: LoopInput): Promise<{ answer: string; thinking: string; answeredBy: string; stopReason: string; hitTurnLimit: boolean }> {
  const { ctx, messages, toolCtx, level, maxTurns, onLog, addUsage } = input;
  let useTools = input.tools.length > 0;
  let answeredBy = input.model;
  let lastAnswer = "";
  let lastReasoning = "";
  let stopReason = "end_turn";

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (ctx.signal?.aborted) break;
    let text = "";
    let reasoning = "";
    const calls: PuterToolCall[] = [];
    let usage: PuterUsage = { inputTokens: 0, outputTokens: 0 };
    // Routes <thinking> tags in the text stream to the thinking panel live, so
    // every model's thinking shows in the collapsible panel, never in the reply.
    const splitter = createThinkingTagSplitter();
    const emit = async (piece: { channel: "text" | "thinking"; text: string }) => {
      if (piece.channel === "thinking") reasoning += piece.text;
      else text += piece.text;
      await onLog("stdout", logLine({ type: "acpx.text_delta", text: piece.text, ...(piece.channel === "thinking" ? { channel: "thinking" } : {}) }));
    };
    try {
      for await (const event of puterStream(messages, { model: input.model, tools: useTools ? input.tools : undefined, signal: ctx.signal })) {
        if (event.type === "text") { for (const piece of splitter.push(event.text)) await emit(piece); }
        else if (event.type === "reasoning") { reasoning += event.text; await onLog("stdout", logLine({ type: "acpx.text_delta", text: event.text, channel: "thinking" })); }
        else if (event.type === "tool_use") calls.push({ id: event.id, type: "function", function: { name: event.name, arguments: JSON.stringify(event.input ?? {}) } });
        else if (event.type === "done") { usage = event.usage; stopReason = event.stopReason; }
      }
      for (const piece of splitter.flush()) await emit(piece);
    } catch (error) {
      if (ctx.signal?.aborted) break;
      // A model that can't take tools: drop them and let it answer in text.
      if (useTools && error instanceof PuterHttpError) {
        await onLog("stdout", logLine({ type: "acpx.status", message: "This model can't use tools; answering in text." }));
        useTools = false;
        continue;
      }
      // Streaming failed outright: fall back to a plain reply with model fallback.
      if (turn === 1) {
        const reply = await puterComplete(messages, { model: input.model, signal: ctx.signal });
        addUsage(reply.model, reply.usage);
        const split = splitThinking(reply.text, reply.reasoning);
        if (split.thinking) await onLog("stdout", logLine({ type: "acpx.text_delta", text: split.thinking, channel: "thinking" }));
        await onLog("stdout", logLine({ type: "acpx.text_delta", text: split.answer }));
        return { answer: split.answer, thinking: split.thinking, answeredBy: reply.model, stopReason: "end_turn", hitTurnLimit: false };
      }
      throw error;
    }

    addUsage(input.model, usage);
    // `text` already has its <thinking> tags routed to `reasoning` by the splitter.
    if (text.trim()) lastAnswer = text.trim();
    if (reasoning.trim()) lastReasoning = reasoning.trim();

    if (calls.length === 0 || stopReason !== "tool_use") {
      return { answer: lastAnswer, thinking: lastReasoning, answeredBy, stopReason, hitTurnLimit: false };
    }
    if (turn >= maxTurns) return { answer: lastAnswer, thinking: lastReasoning, answeredBy, stopReason, hitTurnLimit: true };

    messages.push({ role: "assistant", content: text || null, tool_calls: calls });
    for (const call of calls) {
      if (ctx.signal?.aborted) break;
      let args: unknown = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      await onLog("stdout", logLine({ type: "acpx.tool_call", name: call.function.name, toolUseId: call.id, input: args }));
      const result = await runFreeTool(toolCtx, call.function.name, args);
      await onLog("stdout", logLine({ type: "acpx.tool_result", name: call.function.name, toolUseId: call.id, content: result.content.slice(0, 4_000), ...(result.isError ? { isError: true } : {}) }));
      messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
    }
  }
  return { answer: lastAnswer, thinking: lastReasoning, answeredBy, stopReason, hitTurnLimit: false };
}

async function runImageOnly(
  ctx: AdapterExecutionContext,
  api: ThreadApi,
  issue: { title?: string; description?: string | null; companyId: string },
  lastUser: { id: string; body: string } | null,
  model: PuterImageModelId,
  issueId: string,
  addUsage: (model: string, usage: PuterUsage) => void,
): Promise<void> {
  const ask = (lastUser?.body ?? issue.description ?? issue.title ?? "").trim();
  const pictures = lastUser ? await readCommentPictures(api, issueId, lastUser.id, 1) : [];
  let prompt = ask;
  if (pictures.length) {
    await ctx.onLog("stdout", logLine({ type: "acpx.status", message: "Reading the attached picture" }));
    const described = await puterComplete([{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: pictures[0]! } },
        { type: "text", text: `Someone attached this picture and asked: "${ask || "recreate it"}". Write one detailed prompt, under 70 words, for an image generator to draw this picture with that change applied, keeping everything else the same. Reply with the prompt only.` },
      ],
    }], { model: VISION_MODEL, signal: ctx.signal });
    addUsage(described.model, described.usage);
    prompt = described.text.replace(/^["'\s]+|["'\s]+$/g, "");
  }
  if (!prompt) throw new Error("Nothing to draw yet. Describe a picture, or attach one with the change you want.");
  await ctx.onLog("stdout", logLine({ type: "acpx.status", message: `Drawing with ${model}` }));
  const image = await drawAndUploadImage(api, issue.companyId, issueId, ctx.runId, model, prompt, ctx.signal);
  const body = pictures.length ? `${image.markdown}\n\n_Redrawn from your picture: ${prompt}_` : image.markdown;
  await postReply(api, issueId, body, [image.attachmentId]);
}

/** Builds the run result after the reply has been posted; never posts itself. */
async function finish(
  ctx: AdapterExecutionContext,
  images: number,
  answeredBy: string,
  spent: TurnTotals[],
  summaryBody = "",
): Promise<AdapterExecutionResult> {
  const usage = sumUsage(spent);
  const tokenCost = (await Promise.all(spent.filter((part) => part.input + part.output > 0).map((part) => equivalentTokenCostUsd(part.model, { inputTokens: part.input, outputTokens: part.output })))).reduce((a, b) => a + b, 0);
  const freeUsage: FreeModelRunUsage = {
    model: answeredBy,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    images,
    equivalentUsd: tokenCost + equivalentImageCostUsd(images),
  };
  await ctx.onLog("stdout", `[paperclip] Replied with ${answeredBy}: ${usage.inputTokens + usage.outputTokens} tokens${images ? `, ${images} image${images === 1 ? "" : "s"}` : ""}, free (≈ $${freeUsage.equivalentUsd.toPrecision(2)} at paid prices)\n`);
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "free_models",
    biller: "free_models",
    model: answeredBy,
    costUsd: 0,
    usage,
    usageBasis: "per_run",
    resultJson: { engine: "free_models", freeUsage },
    summary: summaryBody.slice(0, 280),
  };
}
