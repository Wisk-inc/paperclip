/**
 * Reading one source into the index: a feed and its articles, a page, a
 * page and the links it carries, or a page of PDF statutes. Each item is
 * fetched with the same keyless web helpers the free agents use, cut into
 * chunks and stored; a page that has not changed only gets its fetch time
 * moved.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Db } from "@paperclipai/db";
import { readDocument } from "../../adapters/free-models/office.js";
import { webDownload, webFetch } from "../../adapters/free-models/web.js";
import type { MoanSource } from "./sources.js";
import { replacePage, storedPage, touchSource, sourcePageCount } from "./store.js";
import { chunkText, hashText, parseFeed, trimReferences, type FeedItem } from "./text.js";

export interface IngestResult {
  sourceId: string;
  /** Items looked at. */
  items: number;
  /** Pages stored or refreshed. */
  stored: number;
  error: string | null;
}

const ARTICLE_CHARS = 20_000;
const REFERENCE_CHARS = 160_000;
const LAW_CHARS = 400_000;
const FETCH_TIMEOUT_MS = 30_000;
const PDF_TIMEOUT_MS = 90_000;
/** A stored article is not fetched again within this window. */
const ARTICLE_FRESH_MS = 3 * 24 * 60 * 60_000;
const LAW_FRESH_MS = 30 * 24 * 60 * 60_000;

function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!parent) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([parent, timeout]) : timeout;
}

/** Loopback, private, link-local and unspecified addresses: not the public web. */
function privateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === "::" || ip === "::1" || ip.startsWith("::ffff:") || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

/**
 * Links come from feeds and pages other people write, and the index is read
 * by every company: only public sites go in, never this machine or its network.
 */
async function assertPublic(url: string): Promise<void> {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const refused = !/^https?:$/.test(parsed.protocol) || host === "localhost" || host.endsWith(".localhost")
    || (isIP(host) ? privateAddress(host) : (await lookup(host, { all: true }).catch(() => [])).some((entry) => privateAddress(entry.address)));
  if (refused) throw new Error(`${parsed.host} is not a public site`);
}

/** A page from a public site, checked before the request and again after its redirects. */
async function readPage(url: string, signal: AbortSignal, maxChars: number): Promise<Awaited<ReturnType<typeof webFetch>>> {
  await assertPublic(url);
  const page = await webFetch(url, signal, { maxChars });
  await assertPublic(page.url);
  return page;
}

async function download(url: string, signal: AbortSignal): Promise<Awaited<ReturnType<typeof webDownload>>> {
  await assertPublic(url);
  const file = await webDownload(url, signal);
  await assertPublic(file.url);
  return file;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  await assertPublic(url);
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36 AutomaMoan/1", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5" },
    redirect: "follow",
    signal: timeoutSignal(FETCH_TIMEOUT_MS, signal),
  });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  await assertPublic(response.url || url);
  const text = await response.text();
  return text.length > 3_000_000 ? text.slice(0, 3_000_000) : text;
}

/** The first address that answers with feed items. */
async function readFeed(source: MoanSource, signal?: AbortSignal): Promise<FeedItem[]> {
  let lastError = "no feed address";
  for (const url of [source.url, ...(source.alternatives ?? [])]) {
    try {
      const text = await fetchText(url, signal);
      const items = parseFeed(text);
      if (items.length) return items;
      // A bot check or a login page comes back as HTML with a 2xx status.
      lastError = /<(rss|feed|rdf:RDF)\b/i.test(text) ? `${url} had no items` : `${url} answered with a web page instead of a feed (a bot check, most likely)`;
    } catch (error) {
      lastError = `${url} ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  throw new Error(lastError);
}

async function isFresh(db: Db, url: string, within: number): Promise<boolean> {
  const stored = await storedPage(db, url);
  return Boolean(stored && Date.now() - stored.fetchedAt.getTime() < within);
}

async function storeText(db: Db, source: MoanSource, url: string, title: string, text: string, publishedAt: Date | null, options: { size?: number; max?: number } = {}): Promise<boolean> {
  // Citation lists would otherwise win searches for the names they repeat; Postgres text cannot hold the NUL characters some pages and PDFs carry.
  const chunks = chunkText(trimReferences(text.replace(/\0/g, "")), options);
  if (!chunks.length) return false;
  const outcome = await replacePage(db, { sourceId: source.id, url, title: title.replace(/\0/g, ""), topic: source.topic, publishedAt, chunks, contentHash: hashText(chunks.join("\n")) });
  return outcome !== "empty";
}

async function ingestArticle(db: Db, source: MoanSource, item: FeedItem, signal?: AbortSignal): Promise<boolean> {
  if (await isFresh(db, item.link, ARTICLE_FRESH_MS)) return false;
  const page = await readPage(item.link, timeoutSignal(FETCH_TIMEOUT_MS, signal), ARTICLE_CHARS);
  const text = page.text.length > 400 ? page.text : `${item.summary}\n\n${page.text}`;
  return storeText(db, source, page.url, item.title || page.title, text, item.publishedAt ?? new Date(), { size: 1_400, max: 16 });
}

async function ingestRss(db: Db, source: MoanSource, signal?: AbortSignal): Promise<IngestResult> {
  const items = (await readFeed(source, signal)).slice(0, source.maxItems);
  let stored = 0;
  const errors: string[] = [];
  for (const item of items) {
    if (signal?.aborted) break;
    try {
      if (await ingestArticle(db, source, item, signal)) stored += 1;
    } catch (error) {
      errors.push(`${item.link}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sourceId: source.id, items: items.length, stored, error: errors.length === items.length && items.length ? errors[0]! : null };
}

async function ingestPage(db: Db, source: MoanSource, signal?: AbortSignal): Promise<IngestResult> {
  let lastError = "";
  for (const url of [source.url, ...(source.alternatives ?? [])]) {
    try {
      const page = await readPage(url, timeoutSignal(FETCH_TIMEOUT_MS, signal), REFERENCE_CHARS);
      const stored = await storeText(db, source, page.url, page.title, page.text, null, { size: 1_600, max: 100 });
      return { sourceId: source.id, items: 1, stored: stored ? 1 : 0, error: null };
    } catch (error) {
      lastError = `${url} ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { sourceId: source.id, items: 0, stored: 0, error: lastError };
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

function matcherFor(source: MoanSource): RegExp | null {
  try {
    return source.match ? new RegExp(source.match, "i") : null;
  } catch {
    return null;
  }
}

async function ingestCrawl(db: Db, source: MoanSource, signal?: AbortSignal): Promise<IngestResult> {
  const matcher = matcherFor(source);
  let start: Awaited<ReturnType<typeof webFetch>> | null = null;
  let lastError = "";
  for (const url of [source.url, ...(source.alternatives ?? [])]) {
    try { start = await readPage(url, timeoutSignal(FETCH_TIMEOUT_MS, signal), ARTICLE_CHARS); break; } catch (error) { lastError = `${url} ${error instanceof Error ? error.message : String(error)}`; }
  }
  if (!start) return { sourceId: source.id, items: 0, stored: 0, error: lastError };
  let stored = (await storeText(db, source, start.url, start.title, start.text, null, { size: 1_400, max: 12 })) ? 1 : 0;
  const host = new URL(start.url).host;
  const seen = new Set<string>([start.url]);
  const links = start.links.filter((link) => {
    if (seen.has(link.url) || hostOf(link.url) !== host) return false;
    if (matcher && !matcher.test(link.url) && !matcher.test(link.text)) return false;
    if (/\.(pdf|jpg|jpeg|png|gif|zip|mp4|mp3|docx?|xlsx?|pptx?)(\?|$)/i.test(link.url)) return false;
    seen.add(link.url);
    return true;
  }).slice(0, source.maxItems);
  let items = 1;
  for (const link of links) {
    if (signal?.aborted) break;
    items += 1;
    try {
      if (await isFresh(db, link.url, ARTICLE_FRESH_MS)) continue;
      const page = await readPage(link.url, timeoutSignal(FETCH_TIMEOUT_MS, signal), ARTICLE_CHARS);
      if (await storeText(db, source, page.url, page.title || link.text, page.text, new Date(), { size: 1_400, max: 12 })) stored += 1;
    } catch {
      // One page down is not the source down.
    }
  }
  return { sourceId: source.id, items, stored, error: null };
}

async function ingestPdfList(db: Db, source: MoanSource, signal?: AbortSignal): Promise<IngestResult> {
  const matcher = matcherFor(source);
  let listing: Awaited<ReturnType<typeof webFetch>> | null = null;
  let lastError = "";
  for (const url of [source.url, ...(source.alternatives ?? [])]) {
    try { listing = await readPage(url, timeoutSignal(FETCH_TIMEOUT_MS, signal), ARTICLE_CHARS); if (listing.links.length) break; } catch (error) { lastError = `${url} ${error instanceof Error ? error.message : String(error)}`; }
  }
  if (!listing) return { sourceId: source.id, items: 0, stored: 0, error: lastError };
  const seen = new Set<string>();
  const pdfs = listing.links.filter((link) => {
    if (!/\.pdf(\?|$)/i.test(link.url) || seen.has(link.url)) return false;
    if (matcher && !matcher.test(link.text) && !matcher.test(decodeURIComponent(link.url))) return false;
    seen.add(link.url);
    return true;
  }).slice(0, source.maxItems);
  let stored = 0;
  const errors: string[] = [];
  for (const link of pdfs) {
    if (signal?.aborted) break;
    try {
      if (await isFresh(db, link.url, LAW_FRESH_MS)) continue;
      const file = await download(link.url, timeoutSignal(PDF_TIMEOUT_MS, signal));
      const name = decodeURIComponent(new URL(file.url).pathname.split("/").pop() || "law.pdf");
      const read = await readDocument(file.bytes, name, { contentType: file.contentType, maxChars: LAW_CHARS });
      const title = link.text.trim() || name.replace(/\.pdf$/i, "");
      if (await storeText(db, source, file.url, title, read.text, null, { size: 1_800, max: 160 })) stored += 1;
    } catch (error) {
      errors.push(`${link.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sourceId: source.id, items: pdfs.length, stored, error: pdfs.length && errors.length === pdfs.length ? errors[0]! : (pdfs.length ? null : `no matching PDFs found at ${listing.url}`) };
}

/** Reads one source into the index and records how it went. */
export async function ingestSource(db: Db, source: MoanSource, signal?: AbortSignal): Promise<IngestResult> {
  let result: IngestResult;
  try {
    if (source.kind === "rss") result = await ingestRss(db, source, signal);
    else if (source.kind === "page") result = await ingestPage(db, source, signal);
    else if (source.kind === "crawl") result = await ingestCrawl(db, source, signal);
    else result = await ingestPdfList(db, source, signal);
  } catch (error) {
    result = { sourceId: source.id, items: 0, stored: 0, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    await touchSource(db, source.id, { ok: !result.error, error: result.error, pages: await sourcePageCount(db, source.id) });
  } catch {
    // The status row is a convenience; the pages are what matters.
  }
  return result;
}
