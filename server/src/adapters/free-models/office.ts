/**
 * Office documents for the free engine: spreadsheets (.xlsx), presentations
 * (.pptx) and documents (.docx) built from the model's description, and the
 * reverse — the text and structure of a file the person attached, so the model
 * can rework or recreate it.
 */
import ExcelJS from "exceljs";
import { strFromU8, unzipSync } from "fflate";

/** The parts of pptxgenjs used here; its CommonJS typings do not survive a dynamic ESM import. */
interface PptxSlide {
  background: { color: string };
  addShape(type: unknown, options: Record<string, unknown>): unknown;
  addText(text: unknown, options: Record<string, unknown>): unknown;
  addTable(rows: unknown, options: Record<string, unknown>): unknown;
  addChart(type: unknown, data: unknown, options: Record<string, unknown>): unknown;
  addImage(options: Record<string, unknown>): unknown;
  addNotes(notes: string): unknown;
}
interface PptxGenJSType {
  layout: string;
  author: string;
  title: string;
  ShapeType: Record<string, unknown>;
  ChartType: Record<string, unknown>;
  addSlide(): PptxSlide;
  write(options: { outputType: string }): Promise<unknown>;
}

export type CellValue = string | number | boolean | null;

export interface SheetSpec {
  name?: string;
  /** Header row. */
  columns?: string[];
  /** Data rows; a string starting with "=" is a formula (e.g. "=SUM(B2:B9)"). */
  rows?: CellValue[][];
}

export interface SpreadsheetSpec {
  title?: string;
  sheets: SheetSpec[];
}

const MAX_SHEET_ROWS = 5_000;

function cellValue(value: CellValue): ExcelJS.CellValue {
  if (typeof value === "string" && value.startsWith("=") && value.length > 1) return { formula: value.slice(1) } as ExcelJS.CellValue;
  if (value === null || value === undefined) return null;
  return value;
}

/** An .xlsx workbook: bold frozen header, filters, widths from the content. */
export async function buildSpreadsheet(spec: SpreadsheetSpec): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Automa";
  workbook.created = new Date();
  if (spec.title) workbook.title = spec.title;
  const sheets = spec.sheets.length ? spec.sheets : [{ name: "Sheet1", rows: [] }];
  sheets.forEach((sheet, index) => {
    const name = (sheet.name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet${index + 1}`;
    const ws = workbook.addWorksheet(name);
    const columns = sheet.columns ?? [];
    const rows = (sheet.rows ?? []).slice(0, MAX_SHEET_ROWS);
    if (columns.length) {
      const header = ws.addRow(columns);
      header.font = { bold: true };
      header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F0FE" } };
      header.alignment = { vertical: "middle" };
      ws.views = [{ state: "frozen", ySplit: 1 }];
      if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    }
    for (const row of rows) ws.addRow(row.map(cellValue));
    const width = (column: number) => {
      let longest = columns[column]?.length ?? 0;
      for (const row of rows) {
        const text = row[column] == null ? "" : String(row[column]);
        if (text.length > longest) longest = text.length;
      }
      return Math.min(60, Math.max(10, longest + 2));
    };
    const count = Math.max(columns.length, ...rows.map((row) => row.length), 1);
    for (let column = 0; column < count; column += 1) ws.getColumn(column + 1).width = width(column);
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

export type PresentationTheme = "light" | "dark" | "jamaica" | "ocean" | "sunset";

export interface SlideSpec {
  title?: string;
  subtitle?: string;
  bullets?: string[];
  paragraphs?: string[];
  table?: { columns: string[]; rows: CellValue[][] };
  chart?: { type: "bar" | "line" | "pie" | "doughnut"; categories: string[]; series: { name: string; values: number[] }[] };
  /** A picture to draw for this slide, when an image model is paired. */
  image_prompt?: string;
  notes?: string;
}

export interface PresentationSpec {
  title: string;
  subtitle?: string;
  author?: string;
  theme?: PresentationTheme;
  slides: SlideSpec[];
}

export interface SlideImage {
  bytes: Uint8Array;
  mimeType: string;
}

const THEMES: Record<PresentationTheme, { background: string; title: string; text: string; accent: string; muted: string; chart: string[] }> = {
  light: { background: "FFFFFF", title: "0B1F3A", text: "1F2937", accent: "2563EB", muted: "6B7280", chart: ["2563EB", "10B981", "F59E0B", "EF4444", "8B5CF6"] },
  dark: { background: "0F172A", title: "FFFFFF", text: "E2E8F0", accent: "38BDF8", muted: "94A3B8", chart: ["38BDF8", "34D399", "FBBF24", "F87171", "A78BFA"] },
  jamaica: { background: "07301F", title: "FED100", text: "FFFFFF", accent: "FED100", muted: "CFE3D6", chart: ["FED100", "FFFFFF", "6CC04A", "F2A900", "9DD6B8"] },
  ocean: { background: "0B2A4A", title: "FFFFFF", text: "E0F2FE", accent: "22D3EE", muted: "A5C9E6", chart: ["22D3EE", "60A5FA", "A7F3D0", "FDE68A", "F9A8D4"] },
  sunset: { background: "3B0D2E", title: "FFD166", text: "FFE8D6", accent: "EF476F", muted: "E7B8C9", chart: ["FFD166", "EF476F", "06D6A0", "118AB2", "F78C6B"] },
};

export const PRESENTATION_THEMES = Object.keys(THEMES) as PresentationTheme[];

const MAX_SLIDES = 40;

function tableCells(values: CellValue[], options: Record<string, unknown>) {
  return values.map((value) => ({ text: value == null ? "" : String(value), options }));
}

/** A 16:9 .pptx deck: cover slide, then one slide per entry, pictures on the right when there are any. */
export async function buildPresentation(spec: PresentationSpec, images: Map<number, SlideImage> = new Map()): Promise<Uint8Array> {
  // The ESM build's default export is the class; the CommonJS typings say otherwise.
  const loaded = (await import("pptxgenjs")) as unknown as { default: unknown };
  const PptxGenJS = (typeof loaded.default === "function" ? loaded.default : (loaded.default as { default: unknown }).default) as new () => PptxGenJSType;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = spec.author || "Automa";
  pptx.title = spec.title;
  const theme = THEMES[spec.theme ?? "light"] ?? THEMES.light;
  const font = "Calibri";

  const cover = pptx.addSlide();
  cover.background = { color: theme.background };
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 4.9, w: 10, h: 0.12, fill: { color: theme.accent }, line: { color: theme.accent } });
  cover.addText(spec.title, { x: 0.6, y: 1.5, w: 8.8, h: 1.6, fontSize: 40, bold: true, color: theme.title, fontFace: font, valign: "bottom" });
  if (spec.subtitle) cover.addText(spec.subtitle, { x: 0.6, y: 3.2, w: 8.8, h: 1, fontSize: 20, color: theme.muted, fontFace: font, valign: "top" });

  spec.slides.slice(0, MAX_SLIDES).forEach((entry, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: theme.background };
    slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.15, w: 1.2, h: 0.06, fill: { color: theme.accent }, line: { color: theme.accent } });
    slide.addText(entry.title || `Slide ${index + 1}`, { x: 0.6, y: 0.35, w: 8.8, h: 0.8, fontSize: 28, bold: true, color: theme.title, fontFace: font, valign: "middle" });
    const image = images.get(index);
    const bodyWidth = image ? 4.6 : 8.8;
    let y = 1.4;
    if (entry.subtitle) {
      slide.addText(entry.subtitle, { x: 0.6, y, w: bodyWidth, h: 0.5, fontSize: 16, color: theme.muted, fontFace: font, italic: true });
      y += 0.55;
    }
    const lines: Array<{ text: string; options: Record<string, unknown> }> = [];
    for (const paragraph of entry.paragraphs ?? []) lines.push({ text: paragraph, options: { fontSize: 16, color: theme.text, breakLine: true, paraSpaceAfter: 8 } });
    for (const bullet of entry.bullets ?? []) lines.push({ text: bullet, options: { bullet: { indent: 18 }, fontSize: 18, color: theme.text, breakLine: true, paraSpaceAfter: 6 } });
    const tableHeight = entry.table ? Math.min(3.2, 0.4 * (entry.table.rows.length + 1)) : 0;
    const chartHeight = entry.chart ? 3.2 : 0;
    const textHeight = Math.max(0.6, 5.2 - y - tableHeight - chartHeight - 0.2);
    if (lines.length) {
      slide.addText(lines, { x: 0.6, y, w: bodyWidth, h: textHeight, fontFace: font, valign: "top", margin: 4 });
      y += textHeight + 0.1;
    }
    if (entry.table) {
      const columns = entry.table.columns;
      const rows = [
        tableCells(columns, { bold: true, color: theme.background, fill: { color: theme.accent }, fontSize: 12 }),
        ...entry.table.rows.slice(0, 15).map((row) => tableCells(row, { color: theme.text, fontSize: 12 })),
      ];
      slide.addTable(rows, { x: 0.6, y, w: bodyWidth, fontFace: font, border: { type: "solid", color: theme.muted, pt: 0.5 }, autoPage: false });
      y += tableHeight + 0.1;
    }
    if (entry.chart) {
      const kind = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie, doughnut: pptx.ChartType.doughnut }[entry.chart.type] ?? pptx.ChartType.bar;
      const data = entry.chart.series.map((series) => ({ name: series.name, labels: entry.chart!.categories, values: series.values }));
      slide.addChart(kind, data, {
        x: 0.6, y, w: bodyWidth, h: chartHeight,
        chartColors: theme.chart,
        showLegend: entry.chart.series.length > 1 || entry.chart.type === "pie" || entry.chart.type === "doughnut",
        legendColor: theme.text, catAxisLabelColor: theme.text, valAxisLabelColor: theme.text, dataLabelColor: theme.text,
        legendPos: "b",
      });
    }
    if (image) {
      const prefix = image.mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
      slide.addImage({ data: `${prefix};base64,${Buffer.from(image.bytes).toString("base64")}`, x: 5.5, y: 1.4, w: 3.9, h: 3.9, sizing: { type: "contain", w: 3.9, h: 3.9 } });
    }
    if (entry.notes) slide.addNotes(entry.notes);
  });

  const out = await pptx.write({ outputType: "uint8array" });
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
}

export interface DocumentSpec {
  title?: string;
  author?: string;
  /** The body, in Markdown: headings, paragraphs, lists, quotes, code blocks, tables, links. */
  markdown: string;
}

type InlineRun = { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string };

/** Splits one line of Markdown into styled runs: **bold**, *italic*, `code`, [text](url). */
export function inlineRuns(line: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) runs.push({ text: line.slice(last, start) });
    if (match[2] !== undefined || match[3] !== undefined) runs.push({ text: match[2] ?? match[3]!, bold: true });
    else if (match[4] !== undefined) runs.push({ text: match[4], code: true });
    else if (match[5] !== undefined) runs.push({ text: match[5], link: match[6] });
    else runs.push({ text: match[7] ?? match[8]!, italic: true });
    last = start + match[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last) });
  return runs.length ? runs : [{ text: "" }];
}

export type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[]; ordered: boolean }
  | { type: "quote"; text: string }
  | { type: "code"; text: string; language: string }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "rule" };

/** A small Markdown block parser: enough for reports, letters and plans. */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const splitRow = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    const fence = /^```\s*(\w*)\s*$/.exec(trimmed);
    if (fence) {
      flush();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) { code.push(lines[i]!); i += 1; }
      blocks.push({ type: "code", text: code.join("\n"), language: fence[1] ?? "" });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) { flush(); blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]!.replace(/\s+#+$/, "") }); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); blocks.push({ type: "rule" }); continue; }
    if (/^\|.*\|$/.test(trimmed) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1]!.trim())) {
      flush();
      const columns = splitRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i]!.trim())) { rows.push(splitRow(lines[i]!)); i += 1; }
      i -= 1;
      blocks.push({ type: "table", columns, rows });
      continue;
    }
    const bullet = /^([-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flush();
      const ordered = /^\d/.test(bullet[1]!);
      const items = [bullet[2]!];
      while (i + 1 < lines.length) {
        const next = /^([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1]!.trim());
        if (!next || /^\d/.test(next[1]!) !== ordered) break;
        items.push(next[2]!);
        i += 1;
      }
      blocks.push({ type: "bullets", items, ordered });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flush();
      const quote = [trimmed.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && lines[i + 1]!.trim().startsWith(">")) { i += 1; quote.push(lines[i]!.trim().replace(/^>\s?/, "")); }
      blocks.push({ type: "quote", text: quote.join(" ") });
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

/** A .docx from Markdown: real headings, lists, tables and code, so Word's navigation and styles work. */
export async function buildDocument(spec: DocumentSpec): Promise<Uint8Array> {
  const docx = await import("docx");
  const { AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } = docx;
  const runsOf = (text: string, extra: Partial<{ bold: boolean; italics: boolean; color: string; size: number }> = {}) =>
    inlineRuns(text).map((run) => {
      const base = { text: run.text, bold: run.bold || extra.bold, italics: run.italic || extra.italics, color: extra.color, size: extra.size, font: run.code ? "Consolas" : undefined, shading: run.code ? { type: ShadingType.CLEAR, fill: "F1F5F9" } : undefined };
      if (run.link) return new ExternalHyperlink({ link: run.link, children: [new TextRun({ ...base, style: "Hyperlink" })] });
      return new TextRun(base);
    });
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6] as const;
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];
  if (spec.title) children.push(new Paragraph({ text: spec.title, heading: HeadingLevel.TITLE }));
  let listInstance = 0;
  for (const block of parseMarkdownBlocks(spec.markdown)) {
    switch (block.type) {
      case "heading":
        children.push(new Paragraph({ children: runsOf(block.text), heading: headings[Math.min(block.level, 6) - 1] }));
        break;
      case "paragraph":
        children.push(new Paragraph({ children: runsOf(block.text), spacing: { after: 160 } }));
        break;
      case "bullets":
        listInstance += 1;
        for (const item of block.items) {
          children.push(new Paragraph({ children: runsOf(item), numbering: { reference: block.ordered ? "numbers" : "bullets", level: 0, instance: listInstance }, spacing: { after: 60 } }));
        }
        break;
      case "quote":
        children.push(new Paragraph({ children: runsOf(block.text, { italics: true, color: "475569" }), indent: { left: 720 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "94A3B8", space: 8 } }, spacing: { after: 160 } }));
        break;
      case "code":
        for (const line of block.text.split("\n")) {
          children.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: "Consolas", size: 18 })], shading: { type: ShadingType.CLEAR, fill: "F1F5F9" }, spacing: { after: 0 } }));
        }
        children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
        break;
      case "table": {
        const width = Math.floor(9000 / Math.max(1, block.columns.length));
        const row = (cells: string[], header: boolean) => new TableRow({
          tableHeader: header,
          children: block.columns.map((_, index) => new TableCell({
            width: { size: width, type: WidthType.DXA },
            shading: header ? { type: ShadingType.CLEAR, fill: "E8F0FE" } : undefined,
            children: [new Paragraph({ children: runsOf(cells[index] ?? "", header ? { bold: true } : {}) })],
          })),
        });
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(block.columns, true), ...block.rows.map((cells) => row(cells, false))] }));
        children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
        break;
      }
      case "rule":
        children.push(new Paragraph({ text: "", border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CBD5E1", space: 1 } }, spacing: { after: 200 } }));
        break;
    }
  }
  const document = new Document({
    creator: spec.author || "Automa",
    title: spec.title,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: {
      config: [
        { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
        { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      ],
    },
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

export type DocumentKind = "xlsx" | "docx" | "pptx" | "pdf" | "csv" | "text";

export interface ReadDocumentResult {
  kind: DocumentKind;
  /** The content as Markdown-ish text. */
  text: string;
  /** One line about what was read: sheets, slides, pages. */
  summary: string;
}

const MIME_KINDS: Array<[RegExp, DocumentKind]> = [
  [/spreadsheetml|ms-excel/, "xlsx"],
  [/wordprocessingml|msword/, "docx"],
  [/presentationml|ms-powerpoint/, "pptx"],
  [/pdf/, "pdf"],
  [/csv|tab-separated/, "csv"],
];

/** Which reader a file needs, from its name or MIME type. */
export function documentKind(name: string, contentType = ""): DocumentKind | null {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (["txt", "md", "markdown", "json", "html", "htm", "xml", "yaml", "yml", "log", "rtf"].includes(ext)) return "text";
  const type = contentType.toLowerCase();
  for (const [pattern, kind] of MIME_KINDS) if (pattern.test(type)) return kind;
  if (type.startsWith("text/") || type.includes("json")) return "text";
  return null;
}

function excelCellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const record = value as unknown as Record<string, unknown>;
    if ("richText" in record) return (record.richText as Array<{ text: string }>).map((part) => part.text).join("");
    if ("formula" in record) return record.result == null ? `=${record.formula}` : excelCellText(record.result as ExcelJS.CellValue);
    if ("hyperlink" in record) return String(record.text ?? record.hyperlink ?? "");
    if ("error" in record) return String(record.error);
    return JSON.stringify(value);
  }
  return String(value);
}

async function readSpreadsheet(bytes: Uint8Array, maxRows: number): Promise<ReadDocumentResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const parts: string[] = [];
  let sheets = 0;
  workbook.eachSheet((sheet) => {
    sheets += 1;
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= maxRows) return;
      const values = (row.values as ExcelJS.CellValue[]).slice(1).map(excelCellText);
      rows.push(values);
    });
    const width = Math.min(40, Math.max(1, ...rows.map((row) => row.length)));
    const cells = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => (row[i] ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ")).join(" | ")} |`;
    const header = rows[0] ?? [];
    const body = rows.slice(1);
    const more = sheet.rowCount > rows.length ? `\n\n(${sheet.rowCount - rows.length} more rows not shown.)` : "";
    parts.push(`## Sheet: ${sheet.name} (${sheet.rowCount} rows × ${sheet.columnCount} columns)\n\n${cells(header)}\n|${" --- |".repeat(width)}\n${body.map(cells).join("\n")}${more}`);
  });
  return { kind: "xlsx", text: parts.join("\n\n"), summary: `${sheets} sheet${sheets === 1 ? "" : "s"}` };
}

/** HTML from a document converter to Markdown: headings, lists, tables, emphasis, links. */
export function htmlToMarkdown(html: string): string {
  // &amp; goes last, so a document whose text reads "&#65;" keeps it as written;
  // a reference naming no storable character (NUL, past U+10FFFF) becomes a space.
  const decode = (text: string) => text
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => (Number(code) > 0 && Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : " "))
    .replace(/&amp;/g, "&");
  let text = html
    .replace(/\r?\n/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(strong|b)>/gi, "**")
    .replace(/<\/?(em|i)>/gi, "*")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => `\n\n${"#".repeat(Number(level))} ${body.trim()}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => `\n- ${body.trim()}`)
    .replace(/<\/(ul|ol)>/gi, "\n\n")
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row: string) => `\n| ${row.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, (_cell, body) => `${body.trim()} | `).replace(/<[^>]+>/g, "").trim()}`)
    .replace(/<\/table>/gi, "\n\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  text = decode(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Markdown tables need a header separator after their first row.
  return text.replace(/(^|\n\n)(\|[^\n]*\|)\n(?=\|)/g, (_, lead, header) => `${lead}${header}\n|${" --- |".repeat(Math.max(1, (header.match(/\|/g) ?? []).length - 1))}\n`);
}

async function readWordDocument(bytes: Uint8Array): Promise<ReadDocumentResult> {
  const { default: mammoth } = await import("mammoth");
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  const text = htmlToMarkdown(result.value);
  const headings = (text.match(/^#{1,6} /gm) ?? []).length;
  return { kind: "docx", text, summary: `${text.split(/\s+/).filter(Boolean).length} words${headings ? `, ${headings} headings` : ""}` };
}

/** The slide's paragraphs with the largest font size in each, for telling a title from its body. */
function xmlParagraphs(xml: string): Array<{ text: string; size: number }> {
  const paragraphs: Array<{ text: string; size: number }> = [];
  for (const paragraph of xml.split(/<a:p[ >]/).slice(1)) {
    const runs = [...paragraph.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => match[1]!);
    const text = runs.join("").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").trim();
    const size = Math.max(0, ...[...paragraph.matchAll(/<a:rPr[^>]*\bsz="(\d+)"/g)].map((match) => Number(match[1])));
    if (text) paragraphs.push({ text, size });
  }
  return paragraphs;
}

function xmlText(xml: string): string[] {
  return xmlParagraphs(xml).map((paragraph) => paragraph.text);
}

async function readPresentation(bytes: Uint8Array): Promise<ReadDocumentResult> {
  const files = unzipSync(bytes);
  const slideNames = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const parts: string[] = [];
  slideNames.forEach((name, index) => {
    const xml = strFromU8(files[name]!);
    const paragraphs = xmlParagraphs(xml);
    // The title is the title placeholder when the deck marks one, else the
    // first of the largest paragraphs when it is clearly larger than the rest.
    const largest = Math.max(0, ...paragraphs.map((paragraph) => paragraph.size));
    const titleIndex = /type="(?:title|ctrTitle)"/.test(xml) && paragraphs.length
      ? 0
      : paragraphs.findIndex((paragraph) => paragraph.size === largest && largest >= 2400 && paragraphs.some((other) => other.size < largest));
    const title = titleIndex >= 0 ? paragraphs[titleIndex]!.text : `Slide ${index + 1}`;
    const body = paragraphs.filter((_, i) => i !== titleIndex).map((paragraph) => paragraph.text);
    const rels = files[name.replace("slides/", "slides/_rels/") + ".rels"];
    let notes = "";
    if (rels) {
      const target = /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(strFromU8(rels))?.[1];
      const notesXml = target ? files[`ppt/notesSlides/${target}`] : undefined;
      if (notesXml) notes = xmlText(strFromU8(notesXml)).filter((line) => !/^\d+$/.test(line)).join(" ");
    }
    parts.push(`## Slide ${index + 1}: ${title}\n\n${body.map((line) => `- ${line}`).join("\n")}${notes ? `\n\nNotes: ${notes}` : ""}`.trim());
  });
  return { kind: "pptx", text: parts.join("\n\n"), summary: `${slideNames.length} slide${slideNames.length === 1 ? "" : "s"}` };
}

async function readPdf(bytes: Uint8Array): Promise<ReadDocumentResult> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    const pages = result.pages ?? [];
    const text = pages.length
      ? pages.map((page) => `## Page ${page.num}\n\n${page.text.trim()}`).join("\n\n")
      : (result.text ?? "").trim();
    return { kind: "pdf", text, summary: `${pages.length || "?"} page${pages.length === 1 ? "" : "s"}` };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** An office file's zip may unpack to at most this much, in at most this many files. */
const MAX_UNZIPPED_BYTES = 100_000_000;
const MAX_ZIP_FILES = 10_000;

/** Refuses a zip bomb before anything is unpacked: the sizes the archive's directory declares are added up without inflating a byte. */
function assertSafeArchive(bytes: Uint8Array, name: string): void {
  let total = 0;
  let files = 0;
  try {
    unzipSync(bytes, { filter: (file) => { total += file.originalSize; files += 1; return false; } });
  } catch {
    throw new Error(`${name} could not be opened: the file is damaged, or it is not the kind of file its name says.`);
  }
  if (total > MAX_UNZIPPED_BYTES || files > MAX_ZIP_FILES) {
    throw new Error(`${name} unpacks to more than 100 MB or ${MAX_ZIP_FILES.toLocaleString("en-US")} files, too much to read here.`);
  }
}

/**
 * The readable content of a document the person shared: spreadsheets as
 * Markdown tables per sheet, documents as Markdown, decks slide by slide,
 * PDFs page by page. `maxChars` and `offset` page through long files.
 */
export async function readDocument(
  bytes: Uint8Array,
  name: string,
  options: { contentType?: string; maxChars?: number; offset?: number; maxRows?: number } = {},
): Promise<ReadDocumentResult & { totalChars: number; shown: number }> {
  const kind = documentKind(name, options.contentType);
  if (!kind) throw new Error(`${name} is not a document type that can be read (spreadsheets, Word documents, presentations, PDFs, CSV and text files are).`);
  let result: ReadDocumentResult;
  if (kind === "xlsx" || kind === "docx" || kind === "pptx") assertSafeArchive(bytes, name);
  if (kind === "xlsx") result = await readSpreadsheet(bytes, options.maxRows ?? 300);
  else if (kind === "docx") result = await readWordDocument(bytes);
  else if (kind === "pptx") result = await readPresentation(bytes);
  else if (kind === "pdf") result = await readPdf(bytes);
  else {
    const text = Buffer.from(bytes).toString("utf8");
    result = { kind, text, summary: `${text.split("\n").length} lines` };
  }
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const maxChars = Math.max(1_000, Math.floor(options.maxChars ?? 20_000));
  const slice = result.text.slice(offset, offset + maxChars);
  return { ...result, text: slice, totalChars: result.text.length, shown: offset + slice.length };
}

/** A safe file name for a generated document: the asked name with the right extension. */
export function documentFileName(asked: string, extension: "xlsx" | "pptx" | "docx", fallback: string): string {
  const base = (asked || fallback).trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/\.(xlsx|pptx|docx|xls|ppt|doc)$/i, "");
  return `${(base || fallback).slice(0, 80)}.${extension}`;
}
