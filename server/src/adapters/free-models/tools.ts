import {
  clipOutput,
  directApiToolDefinitions,
  runDirectTool,
  type DirectToolRuntime,
} from "@paperclipai/adapter-claude-local/server";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterRuntimeToolAccess } from "@paperclipai/adapter-utils";
import {
  describePuterError,
  PUTER_IMAGE_MODEL_META,
  PUTER_IMAGE_MODELS,
  type PuterImageModelId,
  type PuterImageModelKey,
  type PuterTool,
} from "@paperclipai/shared/puter-ai";
import {
  buildDocument,
  buildPresentation,
  buildSpreadsheet,
  documentFileName,
  PRESENTATION_THEMES,
  readDocument,
  type CellValue,
  type PresentationTheme,
  type SheetSpec,
  type SlideImage,
  type SlideSpec,
} from "./office.js";
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

/** A document the engine made: attached to the reply, and saved in the working folder when there is one. */
export interface SavedDocument {
  attachmentId: string;
  name: string;
  contentPath: string;
  downloadPath: string;
  /** Where it was written in the working folder, relative to it; absent when files are off. */
  savedPath?: string;
}

/** A file the person attached to the conversation, fetched for reading. */
export interface AttachedFile {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface FreeToolContext {
  toggles: FreeToolToggles;
  direct: DirectToolRuntime | null;
  runtimeTools?: AdapterRuntimeToolAccess;
  /** Draws a picture with the bonded model and returns how to show it in the reply. */
  generateImage: (prompt: string) => Promise<{ markdown: string; attachmentId: string }>;
  /** Draws a picture with the bonded model for use inside a file (a slide); absent when no image model is paired. */
  drawPicture?: (prompt: string) => Promise<SlideImage>;
  /** Attaches a made file to the reply (and keeps it in the working folder when files are on). */
  saveDocument: (name: string, bytes: Uint8Array, mimeType: string) => Promise<SavedDocument>;
  /** A file the person attached, by name or attachment id; null when there is none. */
  readAttachment: (ref: string) => Promise<AttachedFile | null>;
  signal?: AbortSignal;
}

export const OFFICE_MIME = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Bash", "Grep", "Glob"]);
/** The tools a toggle can turn off; the document tools are always on. */
const TOGGLED_TOOLS = new Set([...FILE_TOOLS, "Automa", "WebSearch", "WebFetch", "WebCrawl", "WebDownload", "ConnectionsSearch", "ConnectionRequest", "GenerateImage"]);
/** The largest working-folder file ReadDocument opens, the same as a download. */
const MAX_READ_BYTES = 20_000_000;

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

const CELL_SCHEMA = { description: "A cell: text, a number, true/false, or null for empty. Text starting with = is a formula, e.g. =SUM(B2:B9)." };

const CREATE_SPREADSHEET_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "CreateSpreadsheet",
    description: "Make an Excel spreadsheet (.xlsx) and attach it to your reply. Use it whenever the person wants a spreadsheet, workbook, budget, tracker, schedule, price list, roster or any table to open in Excel or Google Sheets. Give each sheet a name, its header columns and its rows; a cell starting with = is a formula (=SUM(B2:B9)). The person downloads the file from the chat.",
    parameters: {
      type: "object",
      properties: {
        file_name: { type: "string", description: "The file name, e.g. budget-2026.xlsx" },
        title: { type: "string", description: "The workbook title" },
        sheets: {
          type: "array",
          description: "One entry per sheet, in order",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The sheet's tab name" },
              columns: { type: "array", items: { type: "string" }, description: "Header row" },
              rows: { type: "array", items: { type: "array", items: CELL_SCHEMA }, description: "Data rows, each a list of cells" },
            },
            required: ["rows"],
          },
        },
      },
      required: ["sheets"],
    },
  },
};

const CREATE_PRESENTATION_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "CreatePresentation",
    description: "Make a PowerPoint presentation (.pptx) and attach it to your reply. Use it for slides, decks, pitches, lessons and talks. You give the title, a theme and one entry per slide: a title with bullets or paragraphs, optionally a table, a chart, speaker notes, and image_prompt to draw a picture for the slide when an image model is paired. A cover slide is added for you.",
    parameters: {
      type: "object",
      properties: {
        file_name: { type: "string", description: "The file name, e.g. pitch.pptx" },
        title: { type: "string", description: "The deck's title (cover slide)" },
        subtitle: { type: "string", description: "Cover subtitle" },
        theme: { type: "string", enum: [...PRESENTATION_THEMES], description: "light (default), dark, jamaica (green, gold, black), ocean or sunset" },
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              subtitle: { type: "string" },
              bullets: { type: "array", items: { type: "string" }, description: "Bullet points" },
              paragraphs: { type: "array", items: { type: "string" }, description: "Plain paragraphs, shown above the bullets" },
              table: { type: "object", properties: { columns: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: CELL_SCHEMA } } }, required: ["columns", "rows"] },
              chart: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["bar", "line", "pie", "doughnut"] },
                  categories: { type: "array", items: { type: "string" }, description: "The x-axis labels or pie slices" },
                  series: { type: "array", items: { type: "object", properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } }, required: ["name", "values"] } },
                },
                required: ["type", "categories", "series"],
              },
              image_prompt: { type: "string", description: "Draw this picture on the slide (needs a paired image model); at most 6 per deck" },
              notes: { type: "string", description: "Speaker notes" },
            },
            required: ["title"],
          },
        },
      },
      required: ["title", "slides"],
    },
  },
};

const CREATE_DOCUMENT_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "CreateDocument",
    description: "Make a Word document (.docx) from Markdown and attach it to your reply. Use it for letters, reports, contracts, agreements, essays, CVs, plans, minutes, forms and anything the person wants as a document file. Headings, lists, tables, quotes, code blocks, bold, italics and links become real Word styles. Write the full text yourself; do not leave placeholders unless the person asked for a template.",
    parameters: {
      type: "object",
      properties: {
        file_name: { type: "string", description: "The file name, e.g. lease-agreement.docx" },
        title: { type: "string", description: "A title line at the top of the document" },
        markdown: { type: "string", description: "The whole document body, in Markdown" },
      },
      required: ["markdown"],
    },
  },
};

const READ_DOCUMENT_TOOL: PuterTool = {
  type: "function",
  function: {
    name: "ReadDocument",
    description: "Read a spreadsheet (.xlsx), Word document (.docx), presentation (.pptx), PDF, CSV or text file: one the person attached to the chat (attachment: its file name), a file in the working folder (path), or a file on the web (url). You get its text and structure (sheets as tables, slides one by one, pages) so you can answer about it, change it, translate it, or recreate it with the Create tools. Long files come in pieces: pass offset to continue.",
    parameters: {
      type: "object",
      properties: {
        attachment: { type: "string", description: "The attached file's name (or attachment id)" },
        path: { type: "string", description: "A file in the working folder, e.g. documents/report.docx" },
        url: { type: "string", description: "An http(s) URL of the file" },
        offset: { type: "integer", description: "Character offset to continue a long file from" },
        max_chars: { type: "integer", description: "How much to read at once (default 20000)" },
      },
    },
  },
};

const OFFICE_TOOLS = [CREATE_SPREADSHEET_TOOL, CREATE_PRESENTATION_TOOL, CREATE_DOCUMENT_TOOL, READ_DOCUMENT_TOOL];

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
  // Documents need no toggle: they are made in memory and attached to the reply.
  tools.push(...OFFICE_TOOLS);
  return tools;
}

function cell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (item == null ? "" : String(item))) : [];
}

function rows(value: unknown): CellValue[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => (Array.isArray(row) ? row.map(cell) : row && typeof row === "object" ? Object.values(row as Record<string, unknown>).map(cell) : [cell(row)]));
}

function sheetSpecs(value: unknown): SheetSpec[] {
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return list
    .filter((sheet): sheet is Record<string, unknown> => Boolean(sheet) && typeof sheet === "object")
    .map((sheet) => ({ name: typeof sheet.name === "string" ? sheet.name : undefined, columns: sheet.columns === undefined ? undefined : strings(sheet.columns), rows: rows(sheet.rows) }))
    .filter((sheet) => (sheet.columns?.length ?? 0) > 0 || sheet.rows!.length > 0);
}

function slideSpecs(value: unknown): SlideSpec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((slide): slide is Record<string, unknown> => Boolean(slide) && typeof slide === "object")
    .map((slide) => {
      const table = slide.table && typeof slide.table === "object" ? (slide.table as Record<string, unknown>) : null;
      const chart = slide.chart && typeof slide.chart === "object" ? (slide.chart as Record<string, unknown>) : null;
      const series = Array.isArray(chart?.series)
        ? (chart!.series as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").map((item) => ({ name: String(item.name ?? "Series"), values: (Array.isArray(item.values) ? item.values : []).map((n) => Number(n) || 0) }))
        : [];
      const chartType = typeof chart?.type === "string" && ["bar", "line", "pie", "doughnut"].includes(chart.type) ? (chart.type as "bar" | "line" | "pie" | "doughnut") : "bar";
      return {
        title: typeof slide.title === "string" ? slide.title : undefined,
        subtitle: typeof slide.subtitle === "string" ? slide.subtitle : undefined,
        bullets: strings(slide.bullets),
        paragraphs: strings(slide.paragraphs),
        table: table && Array.isArray(table.columns) ? { columns: strings(table.columns), rows: rows(table.rows) } : undefined,
        chart: chart && series.length ? { type: chartType, categories: strings(chart.categories), series } : undefined,
        image_prompt: typeof slide.image_prompt === "string" && slide.image_prompt.trim() ? slide.image_prompt.trim() : undefined,
        notes: typeof slide.notes === "string" ? slide.notes : undefined,
      };
    });
}

const MAX_SLIDE_PICTURES = 6;

function savedLine(saved: SavedDocument): string {
  return `It is attached to your reply${saved.savedPath ? ` and saved at ${saved.savedPath}` : ""}; the person can open or download it from the chat. Say in a line or two what is in it (and link it as [${saved.name}](${saved.downloadPath}) if you like); do not paste its whole contents into the reply.`;
}

function str(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === "string" ? (input[key] as string) : "";
}

/** A number the model gave, as a number or as text; undefined when it gave none. */
function num(input: Record<string, unknown>, key: string): number | undefined {
  const value = typeof input[key] === "string" && (input[key] as string).trim() ? Number(input[key]) : input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Why the paired image model did not draw, in plain words naming it, not the service's raw answer. */
function imageFailure(ctx: FreeToolContext, error: unknown): string {
  const model = ctx.toggles.imageModel;
  const key = (Object.keys(PUTER_IMAGE_MODELS) as PuterImageModelKey[]).find((candidate) => PUTER_IMAGE_MODELS[candidate] === model);
  return describePuterError(error, key ? PUTER_IMAGE_MODEL_META[key].label : model ?? "The image model").message;
}

/** The file name a URL ends in, without any folders a decoded name would bring. */
function urlFileName(url: string): string {
  const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // A malformed escape: the name stays as written.
  }
  const base = path.basename(name);
  return base && base !== "." && base !== ".." ? base : "download";
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
  /** Set when the tool made a file that is attached to the reply. */
  document?: SavedDocument;
}

/** Runs one tool call for the free engine. Unknown tools come back as errors the model can read. */
export async function runFreeTool(ctx: FreeToolContext, name: string, rawInput: unknown): Promise<FreeToolResult> {
  const input = (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {}) as Record<string, unknown>;
  // A model can name a tool it was not offered: only this run's tools run.
  if (!freeToolDefinitions(ctx).some((tool) => tool.function.name === name)) {
    return { content: TOGGLED_TOOLS.has(name) ? `The ${name} tool is turned off for this agent.` : `There is no tool named ${name}.`, isError: true };
  }
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
        depth: num(input, "depth"),
        maxPages: num(input, "max_pages"),
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
      const root = path.resolve(ctx.direct.cwd);
      const asked = str(input, "path").trim().replace(/^\/+/, "");
      if (asked && !path.resolve(root, asked).startsWith(root + path.sep)) return { content: "The path must be inside the working folder.", isError: true };
      const file = await webDownload(str(input, "url"), ctx.signal);
      const target = path.resolve(root, asked || path.join("downloads", urlFileName(file.url)));
      // Written directly, not through Bash: a file passed in a shell command overflows its argument limit past ~96 KB.
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.bytes);
      } catch (error) {
        return { content: `Could not save the file: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
      const relative = path.relative(root, target).split(path.sep).join("/");
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
      let image: { markdown: string; attachmentId: string };
      try {
        image = await ctx.generateImage(prompt);
      } catch (error) {
        return { content: `GenerateImage failed: ${imageFailure(ctx, error)}`, isError: true };
      }
      return { content: "The picture was drawn and added to your reply. Do not repeat the image markdown yourself.", isError: false, attachmentId: image.attachmentId, imageMarkdown: image.markdown };
    }
    if (name === "CreateSpreadsheet") {
      const sheets = sheetSpecs(input.sheets);
      if (!sheets.length) return { content: "CreateSpreadsheet needs at least one sheet with columns or rows.", isError: true };
      const title = str(input, "title").trim();
      const fileName = documentFileName(str(input, "file_name"), "xlsx", title || "spreadsheet");
      const bytes = await buildSpreadsheet({ title: title || undefined, sheets });
      const saved = await ctx.saveDocument(fileName, bytes, OFFICE_MIME.xlsx);
      const total = sheets.reduce((count, sheet) => count + (sheet.rows?.length ?? 0), 0);
      return { content: `Made ${fileName}: ${sheets.length} sheet${sheets.length === 1 ? "" : "s"} (${sheets.map((sheet) => sheet.name ?? "Sheet").join(", ")}), ${total} rows. ${savedLine(saved)}`, isError: false, document: saved };
    }
    if (name === "CreatePresentation") {
      const slides = slideSpecs(input.slides);
      const title = str(input, "title").trim();
      if (!title || !slides.length) return { content: "CreatePresentation needs a title and at least one slide.", isError: true };
      const theme = (PRESENTATION_THEMES as string[]).includes(str(input, "theme")) ? (str(input, "theme") as PresentationTheme) : "light";
      const images = new Map<number, SlideImage>();
      const drawn: string[] = [];
      if (ctx.drawPicture) {
        for (const [index, slide] of slides.entries()) {
          if (!slide.image_prompt || images.size >= MAX_SLIDE_PICTURES) continue;
          try {
            images.set(index, await ctx.drawPicture(slide.image_prompt));
          } catch (error) {
            drawn.push(`slide ${index + 1}: picture not drawn (${imageFailure(ctx, error)})`);
          }
        }
      } else if (slides.some((slide) => slide.image_prompt)) {
        drawn.push("no image model is paired, so the slides have no pictures");
      }
      const fileName = documentFileName(str(input, "file_name"), "pptx", title);
      const bytes = await buildPresentation({ title, subtitle: str(input, "subtitle") || undefined, theme, slides }, images);
      const saved = await ctx.saveDocument(fileName, bytes, OFFICE_MIME.pptx);
      const notes = drawn.length ? ` Notes: ${drawn.join("; ")}.` : "";
      return { content: `Made ${fileName}: ${slides.length + 1} slides (cover + ${slides.length}), theme ${theme}${images.size ? `, ${images.size} picture${images.size === 1 ? "" : "s"}` : ""}.${notes} ${savedLine(saved)}`, isError: false, document: saved };
    }
    if (name === "CreateDocument") {
      const markdown = str(input, "markdown").trim();
      if (!markdown) return { content: "CreateDocument needs the document body in markdown.", isError: true };
      const title = str(input, "title").trim();
      const fileName = documentFileName(str(input, "file_name"), "docx", title || "document");
      const bytes = await buildDocument({ title: title || undefined, markdown });
      const saved = await ctx.saveDocument(fileName, bytes, OFFICE_MIME.docx);
      const words = markdown.split(/\s+/).filter(Boolean).length;
      return { content: `Made ${fileName}: about ${words} words. ${savedLine(saved)}`, isError: false, document: saved };
    }
    if (name === "ReadDocument") {
      const ref = str(input, "attachment").trim();
      const url = str(input, "url").trim();
      const relative = str(input, "path").trim();
      let bytes: Uint8Array;
      let fileName: string;
      let contentType = "";
      if (ref) {
        const found = await ctx.readAttachment(ref);
        if (!found) return { content: `There is no attachment named "${ref}" on this chat. Ask the person to attach the file, or give a path or url.`, isError: true };
        bytes = found.bytes; fileName = found.name; contentType = found.contentType;
      } else if (url) {
        if (!ctx.toggles.web) return { content: "Reading a file from the web needs Web turned on. Ask the person to attach the file to the chat instead.", isError: true };
        const file = await webDownload(url, ctx.signal);
        bytes = file.bytes; contentType = file.contentType;
        fileName = urlFileName(file.url);
      } else if (relative) {
        if (!ctx.direct || !ctx.toggles.filesAndCommands) return { content: "Reading files from the working folder needs Files & commands turned on. Attach the file to the chat instead, or give a url.", isError: true };
        const root = path.resolve(ctx.direct.cwd);
        const absolute = path.resolve(root, relative);
        if (absolute !== root && !absolute.startsWith(root + path.sep)) return { content: "The path must be inside the working folder.", isError: true };
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) return { content: `${relative} is not a file. List a folder with Glob, then read a file in it.`, isError: true };
        if (stat.size > MAX_READ_BYTES) return { content: `${relative} is over 20 MB, too large to read here. Look at part of it with Bash (head, tail, split) instead.`, isError: true };
        bytes = new Uint8Array(await fs.readFile(absolute));
        fileName = path.basename(absolute);
      } else {
        return { content: "ReadDocument needs an attachment name, a path or a url.", isError: true };
      }
      const read = await readDocument(bytes, fileName, { contentType, offset: Number(input.offset) || 0, maxChars: Number(input.max_chars) || undefined });
      const more = read.totalChars > read.shown ? `\n\n(${read.totalChars - read.shown} more characters; call again with offset ${read.shown} to continue.)` : "";
      return { content: `# ${fileName} (${read.kind}, ${read.summary})\n\n${read.text}${more}`, isError: false };
    }
    return { content: `There is no tool named ${name}.`, isError: true };
  } catch (error) {
    return { content: `${name} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}
