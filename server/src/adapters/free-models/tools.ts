import {
  clipOutput,
  directApiToolDefinitions,
  runDirectTool,
  type DirectToolRuntime,
} from "@paperclipai/adapter-claude-local/server";
import type { AdapterRuntimeToolAccess } from "@paperclipai/adapter-utils";
import type { PuterImageModelId, PuterTool } from "@paperclipai/shared/puter-ai";
import { webCrawl, webDownload, webFetch, webSearch } from "./web.js";

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
    description: "Search the whole web and get results (title, URL, snippet). Set count for a broad sweep (up to 60 at a time); run several searches with different queries to cover thousands of sites, then WebFetch the promising results to read them.",
    parameters: { type: "object", properties: { query: { type: "string", description: "What to search for" }, count: { type: "integer", description: "How many results to return (default 8, up to 60)" } }, required: ["query"] },
  },
};

const WEB_FETCH_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "WebFetch",
    description: "Open a URL and read it. mode \"text\" (default) gives a web page's readable text; mode \"raw\" gives the source as served: a JavaScript file, JSON, CSS or the page's HTML, for reading code. Every call also lists the page's links and the script/style/JSON files it loads, so you can dig deeper by fetching those. Long bodies are read in pieces: pass offset to continue.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to read" },
        mode: { type: "string", enum: ["text", "raw"], description: "text for prose, raw for source code and data files" },
        offset: { type: "integer", description: "Character offset to continue reading a long body from" },
      },
      required: ["url"],
    },
  },
};

const WEB_CRAWL_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "WebCrawl",
    description: "Dig into a site: read a page, then follow its links a few hops deep (same site unless same_site is false) and report each page's title, an excerpt and the files it loads. Use it to map a site, find where something lives, or gather a set of pages before reading the right ones with WebFetch.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Where to start" },
        depth: { type: "integer", description: "How many link hops to follow (0 to 3, default 1)" },
        max_pages: { type: "integer", description: "Stop after this many pages (default 8, up to 12)" },
        same_site: { type: "boolean", description: "Stay on the starting site (default true)" },
        match: { type: "string", description: "Only follow links whose URL or text matches this regular expression" },
      },
      required: ["url"],
    },
  },
};

const WEB_DOWNLOAD_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "WebDownload",
    description: "Download a file from a URL (a script, an archive, an image, a dataset, up to 20 MB) into the working folder, so you can open it with Read, run it, or keep it. Returns the saved path and size.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL of the file" },
        path: { type: "string", description: "Where to save it, relative to the working folder (default: downloads/<file name>)" },
      },
      required: ["url"],
    },
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
  if (ctx.toggles.web) tools.push(WEB_SEARCH_TOOL, WEB_FETCH_TOOL, WEB_CRAWL_TOOL);
  // Saving needs the file tools' working folder.
  if (ctx.toggles.web && ctx.toggles.filesAndCommands && ctx.direct) tools.push(WEB_DOWNLOAD_TOOL);
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
      const count = typeof input.count === "number" ? input.count : Number(input.count) || undefined;
      const results = await webSearch(str(input, "query"), count, ctx.signal);
      if (results.length === 0) return { content: "No results.", isError: false };
      return { content: `${results.length} results:\n\n` + results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n"), isError: false };
    }
    if (name === "WebFetch") {
      const mode = input.mode === "raw" ? "raw" : "text";
      const offset = Number(input.offset) || 0;
      const page = await webFetch(str(input, "url"), ctx.signal, { mode, offset });
      const shown = offset + page.text.length;
      const more = page.totalChars > shown ? `\n\n(${page.totalChars - shown} more characters; call again with offset ${shown} to continue.)` : "";
      const links = page.links.length ? `\n\nLinks (${page.links.length}):\n` + page.links.slice(0, 25).map((link) => `- ${link.text ? `${link.text} ` : ""}${link.url}`).join("\n") : "";
      const assets = page.assets.length ? `\n\nFiles this page loads (fetch with mode \"raw\" to read the code):\n` + page.assets.slice(0, 20).map((asset) => `- ${asset}`).join("\n") : "";
      return { content: `# ${page.title}\n${page.url} · ${page.contentType}${offset ? ` · from character ${offset}` : ""}\n\n${page.text}${more}${links}${assets}`, isError: false };
    }
    if (name === "WebCrawl") {
      const pages = await webCrawl(str(input, "url"), {
        depth: Number(input.depth) || undefined,
        maxPages: Number(input.max_pages) || undefined,
        sameSite: input.same_site === false || input.same_site === "false" ? false : true,
        match: str(input, "match") || undefined,
      }, ctx.signal);
      return {
        content: `${pages.length} pages:\n\n` + pages.map((page, index) => page.error
          ? `${index + 1}. ${page.url}\n   could not read: ${page.error}`
          : `${index + 1}. ${page.title}\n   ${page.url} · ${page.links} links${page.assets.length ? `\n   loads: ${page.assets.join(", ")}` : ""}\n   ${page.excerpt.replace(/\s+/g, " ").slice(0, 400)}`).join("\n\n"),
        isError: false,
      };
    }
    if (name === "WebDownload") {
      if (!ctx.direct) return { content: "Saving files is turned off for this agent (Files & commands).", isError: true };
      const file = await webDownload(str(input, "url"), ctx.signal);
      const fromUrl = decodeURIComponent(new URL(file.url).pathname.split("/").filter(Boolean).pop() || "download");
      const relative = (str(input, "path") || `downloads/${fromUrl}`).replace(/^\/+/, "").replace(/\.\.(\/|\\|$)/g, "");
      const base64 = Buffer.from(file.bytes).toString("base64");
      // Written through the agent's own Bash tool, so it lands in the same working folder its other files use.
      const outcome = await runDirectTool(ctx.direct, "Bash", {
        command: `mkdir -p "$(dirname '${relative.replaceAll("'", "'\\''")}')" && printf '%s' '${base64}' | base64 -d > '${relative.replaceAll("'", "'\\''")}' && ls -l '${relative.replaceAll("'", "'\\''")}'`,
        description: `Save ${relative}`,
      });
      if (outcome.isError) return { content: `Could not save the file: ${outcome.content}`, isError: true };
      return { content: `Saved ${file.url} (${file.contentType}, ${file.bytes.byteLength.toLocaleString()} bytes) to ${relative}. Open it with Read, or run it with Bash.`, isError: false };
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
