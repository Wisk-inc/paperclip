/**
 * The text side of Moan's knowledge: reading feeds, cutting pages into
 * chunks, turning a question into search terms, and writing the retrieved
 * passages into the prompt. No database here, so it all tests on its own.
 */
import { createHash } from "node:crypto";

export interface FeedItem {
  title: string;
  link: string;
  publishedAt: Date | null;
  summary: string;
}

function unwrap(value: string | undefined): string {
  if (!value) return "";
  const text = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ");
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return match?.[1];
}

function dateOf(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(unwrap(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Items from an RSS 2.0 or Atom feed, newest first as the feed lists them. */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const rss = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  for (const block of rss) {
    const link = unwrap(tag(block, "link")) || /<guid[^>]*>([\s\S]*?)<\/guid>/i.exec(block)?.[1]?.trim() || "";
    const title = unwrap(tag(block, "title"));
    if (!title || !/^https?:\/\//i.test(link)) continue;
    items.push({ title, link, publishedAt: dateOf(tag(block, "pubDate") ?? tag(block, "dc:date")), summary: unwrap(tag(block, "description") ?? tag(block, "content:encoded")).slice(0, 600) });
  }
  if (items.length) return items;
  const atom = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? [];
  for (const block of atom) {
    const href = /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? /<link[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? "";
    const link = href.replace(/&amp;/g, "&");
    const title = unwrap(tag(block, "title"));
    if (!title || !/^https?:\/\//i.test(link)) continue;
    items.push({ title, link, publishedAt: dateOf(tag(block, "published") ?? tag(block, "updated")), summary: unwrap(tag(block, "summary") ?? tag(block, "content")).slice(0, 600) });
  }
  return items;
}

/** Cuts a page into chunks of about `size` characters on paragraph and sentence edges. */
export function chunkText(text: string, options: { size?: number; max?: number } = {}): string[] {
  const size = Math.max(300, options.size ?? 1_400);
  const max = Math.max(1, options.max ?? 12);
  const clean = text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let current = "";
  const push = () => { if (current.trim().length > 40) chunks.push(current.trim()); current = ""; };
  for (const paragraph of clean.split(/\n\n+/)) {
    const pieces = paragraph.length > size ? paragraph.split(/(?<=[.!?])\s+/) : [paragraph];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 1 > size) push();
      if (chunks.length >= max) return chunks;
      current = current ? `${current}\n${piece}` : piece;
      while (current.length > size * 1.5) { chunks.push(current.slice(0, size).trim()); current = current.slice(size); if (chunks.length >= max) return chunks; }
    }
  }
  push();
  return chunks.slice(0, max);
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

const STOPWORDS = new Set(("a an the and or but if so of to in on at by for with from into over under about as is are was were be been being am do does did done have has had can could will would should may might must shall let me my mine we us our ours you your yours he him his she her hers it its they them their theirs this that these those there here what which who whom whose when where why how all any some more most much many few such no not nor only own same than too very just also then once again further still even ever never now new old one two three first last next tell know think want need make made give take come came get got going gone say said see seen like want please thing things something anything nothing everything someone anyone everyone " +
  // Patois function words and fillers.
  "mi yuh yu im shi ar wi unu dem di dat dis deh seh mek tek nuh nah cyaan caan neva fi pon inna outta weh wah wha whe how wen bout ting tings nuff likkle bare cho zeen seen yah yaad bredda sistren bredrin man gyal bwoy pickney a go gwaan gwine haffi affi hafi did ben en done ya suh dung waan wan nyam gi si tan lef fawud galang sumn tink deh-deh wi-ah ah eeh yes yeh nope").split(/\s+/));

/** The search words in a question: content words, lowercase, at most eight. */
export function queryTerms(question: string, limit = 8): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of question.toLowerCase().replace(/[’'`]/g, "").split(/[^a-z0-9]+/)) {
    const word = raw.trim();
    if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
    if (terms.length >= limit) break;
  }
  return terms;
}

export interface KnowledgePassage {
  sourceName: string;
  url: string;
  title: string;
  publishedAt: Date | string | null;
  content: string;
}

const MAX_CONTEXT_CHARS = 7_000;
const MAX_EXCERPT = 600;

function dayOf(value: Date | string | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** Retrieved passages as the prompt gets them: one bullet per page, source and date first, link, then the excerpt. */
export function formatContext(passages: KnowledgePassage[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  let total = 0;
  for (const passage of passages) {
    if (seen.has(passage.url)) continue;
    seen.add(passage.url);
    const day = dayOf(passage.publishedAt);
    const excerpt = passage.content.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT);
    const line = `- [${passage.sourceName}${day ? ` · ${day}` : ""}] ${passage.title.trim() || passage.url}\n  ${passage.url}\n  ${excerpt}`;
    if (total + line.length > MAX_CONTEXT_CHARS) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

/** "2 hours ago", "just now", "3 days ago". */
export function timeAgo(value: Date | string | null, now = Date.now()): string {
  if (!value) return "never";
  const then = (value instanceof Date ? value : new Date(value)).getTime();
  if (Number.isNaN(then)) return "never";
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
