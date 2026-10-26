import {
  clipOutput,
  directApiToolDefinitions,
  runDirectTool,
  type DirectToolRuntime,
} from "@paperclipai/adapter-claude-local/server";
import type { AdapterRuntimeToolAccess } from "@paperclipai/adapter-utils";
import type { PuterImageModelId, PuterTool } from "@paperclipai/shared/puter-ai";
import { webFetch, webSearch } from "./web.js";

/** What the agent is allowed to do this run, read from its config toggles. */
export interface FreeToolToggles {
  filesAndCommands: boolean;
  teammatesAndTasks: boolean;
  web: boolean;
  connections: boolean;
  /** The paired image model, or null when none is bonded. */
  imageModel: PuterImageModelId | null;
}

export interface FreeToolContext {
  toggles: FreeToolToggles;
  direct: DirectToolRuntime | null;
  runtimeTools?: AdapterRuntimeToolAccess;
  /** Draws a picture with the bonded model and returns how to show it in the reply. */
  generateImage: (prompt: string) => Promise<{ markdown: string; attachmentId: string }>;
  signal?: AbortSignal;
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Bash", "Grep", "Glob"]);

/** Converts an Anthropic tool definition to the OpenAI function shape Puter takes. */
function toFunction(tool: { name: string; description?: string; input_schema: unknown }): PuterTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: (tool.input_schema as Record<string, unknown>) ?? { type: "object", properties: {} },
    },
  };
}

const WEB_SEARCH_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "WebSearch",
    description: "Search the web and get the top results (title, URL, snippet). Use it to find current information, then WebFetch a result to read it.",
    parameters: { type: "object", properties: { query: { type: "string", description: "What to search for" } }, required: ["query"] },
  },
};

const WEB_FETCH_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "WebFetch",
    description: "Open a URL and read it as text (a web page, a JSON API, or a plain-text file). Returns the page title and its readable content.",
    parameters: { type: "object", properties: { url: { type: "string", description: "The http(s) URL to read" } }, required: ["url"] },
  },
};

const CONNECTIONS_SEARCH_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "ConnectionsSearch",
    description: "Find which of the person's connected apps (Gmail, Slack, GitHub, Google Drive and more) could do a task, so you can act through them.",
    parameters: { type: "object", properties: { query: { type: "string", description: "The task or app you need, e.g. 'send an email' or 'read a Google Sheet'" } }, required: ["query"] },
  },
};

const CONNECTION_REQUEST_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "ConnectionRequest",
    description: "Ask the person to connect or grant access to an app (from ConnectionsSearch) when it is not connected yet.",
    parameters: { type: "object", properties: { service: { type: "string", description: "The service id from ConnectionsSearch" } }, required: ["service"] },
  },
};

function imageTool(model: PuterImageModelId): PuterTool {
  return {
    type: "function",
    function: {
      name: "GenerateImage",
      description: `Draw a picture with the paired image model (${model}) and add it to your reply. Give a detailed prompt. The picture appears in the chat and the person can save it.`,
      parameters: { type: "object", properties: { prompt: { type: "string", description: "A detailed description of the picture to draw" } }, required: ["prompt"] },
    },
  };
}

/** The tools offered to the model this run, in the order they're introduced in the prompt. */
export function freeToolDefinitions(ctx: FreeToolContext): PuterTool[] {
  const tools: PuterTool[] = [];
  const direct = ctx.direct ? directApiToolDefinitions({ eagerInput: false }) : [];
  if (ctx.toggles.filesAndCommands) tools.push(...direct.filter((tool) => FILE_TOOLS.has(tool.name)).map(toFunction));
  if (ctx.toggles.teammatesAndTasks) {
    const automa = direct.find((tool) => tool.name === "Automa");
    if (automa) tools.push(toFunction(automa));
  }
  if (ctx.toggles.web) tools.push(WEB_SEARCH_TOOL, WEB_FETCH_TOOL);
  if (ctx.toggles.connections && ctx.runtimeTools) tools.push(CONNECTIONS_SEARCH_TOOL, CONNECTION_REQUEST_TOOL);
  if (ctx.toggles.imageModel) tools.push(imageTool(ctx.toggles.imageModel));
  return tools;
}

function str(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === "string" ? (input[key] as string) : "";
}

async function callRuntimeConnection(
  ctx: FreeToolContext,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const runtime = ctx.runtimeTools;
  if (!runtime) return { content: "Connections aren't available in this run.", isError: true };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.bearerToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    return { content: clipOutput(`HTTP ${response.status}\n${await response.text()}`), isError: !response.ok };
  } catch (error) {
    return { content: `Could not reach connections: ${(error as Error).message}`, isError: true };
  }
}

export interface FreeToolResult {
  content: string;
  isError: boolean;
  /** Set when the tool produced a picture to add to the reply. */
  attachmentId?: string;
  imageMarkdown?: string;
}

/** Runs one tool call for the free engine. Unknown tools come back as errors the model can read. */
export async function runFreeTool(ctx: FreeToolContext, name: string, rawInput: unknown): Promise<FreeToolResult> {
  const input = (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {}) as Record<string, unknown>;
  try {
    if (FILE_TOOLS.has(name) || name === "Automa") {
      if (!ctx.direct) return { content: `The ${name} tool is turned off for this agent.`, isError: true };
      const outcome = await runDirectTool(ctx.direct, name, input);
      return { content: outcome.content, isError: outcome.isError };
    }
    if (name === "WebSearch") {
      const results = await webSearch(str(input, "query"), ctx.signal);
      if (results.length === 0) return { content: "No results.", isError: false };
      return { content: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n"), isError: false };
    }
    if (name === "WebFetch") {
      const page = await webFetch(str(input, "url"), ctx.signal);
      return { content: `# ${page.title}\n${page.url}\n\n${page.text}`, isError: false };
    }
    if (name === "ConnectionsSearch") {
      return await callRuntimeConnection(ctx, ctx.runtimeTools!.rest.connectionsSearch, { query: str(input, "query") });
    }
    if (name === "ConnectionRequest") {
      return await callRuntimeConnection(ctx, ctx.runtimeTools!.rest.connectionRequest, { service: str(input, "service") });
    }
    if (name === "GenerateImage") {
      const prompt = str(input, "prompt").trim();
      if (!prompt) return { content: "GenerateImage needs a prompt.", isError: true };
      const image = await ctx.generateImage(prompt);
      return { content: "The picture was drawn and added to your reply. Do not repeat the image markdown yourself.", isError: false, attachmentId: image.attachmentId, imageMarkdown: image.markdown };
    }
    return { content: `There is no tool named ${name}.`, isError: true };
  } catch (error) {
    return { content: `${name} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}
