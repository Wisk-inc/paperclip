/**
 * Keyless web access for free-model agents: a search that scrapes DuckDuckGo's
 * HTML results, and a fetch that turns a page into readable text. No API key,
 * so it works the same on a phone as on a server.
 */

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36";
const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 60;
// DuckDuckGo's HTML endpoint returns roughly this many results per page.
const MAX_PAGE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 12_000;
/** Source files (scripts, styles, JSON) are read in bigger pieces than prose. */
const MAX_RAW_CHARS = 60_000;
const MAX_LINKS = 40;
const MAX_CRAWL_PAGES = 12;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** DuckDuckGo wraps each result link in a redirect that carries the real URL in uddg. */
function realUrl(href: string): string {
  const match = /[?&]uddg=([^&]+)/.exec(href);
  if (match) { try { return decodeURIComponent(match[1]!); } catch { /* fall through */ } }
  if (href.startsWith("//")) return `https:${href}`;
  return href;
}

function parsePage(html: string): WebSearchResult[] {
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (let match = snippetPattern.exec(html); match; match = snippetPattern.exec(html)) snippets.push(stripTags(match[1]!));
  const results: WebSearchResult[] = [];
  let index = 0;
  for (let match = linkPattern.exec(html); match; match = linkPattern.exec(html)) {
    const url = realUrl(match[1]!);
    const title = stripTags(match[2]!);
    if (!title || !/^https?:/.test(url)) { index += 1; continue; }
    results.push({ title, url, snippet: snippets[index] ?? "" });
    index += 1;
  }
  return results;
}

/**
 * One web search across the whole index (not a fixed shortlist), returning up
 * to `limit` de-duplicated results. Deep pagination needs a per-session token
 * the scraper can't mint, so breadth across thousands of sites comes from the
 * agent running many searches with different queries and reading many pages in
 * one run — which its tool loop is sized for.
 */
export async function webSearch(query: string, limit = DEFAULT_RESULTS, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const want = Math.max(1, Math.min(limit, MAX_RESULTS));
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": UA, accept: "text/html" },
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Search answered ${response.status}`);
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const result of parsePage(await response.text())) {
    const key = result.url.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(result);
    if (results.length >= want) break;
  }
  return results;
}

export interface WebPage {
  url: string;
  title: string;
  /** Readable text (text mode) or the source itself (raw mode), from `offset`. */
  text: string;
  /** The response's content type. */
  contentType: string;
  /** Characters in the whole body, so the agent knows what it has not seen yet. */
  totalChars: number;
  /** Links on the page, absolute, same-site first. */
  links: { url: string; text: string }[];
  /** Script, stylesheet and JSON files the page loads, absolute. */
  assets: string[];
}

function absolute(base: string, href: string): string | null {
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/#.*$/, "") : null;
  } catch {
    return null;
  }
}

/** The links and loaded files on a page, absolute and de-duplicated. */
export function pageLinks(html: string, base: string): { links: { url: string; text: string }[]; assets: string[] } {
  const links: { url: string; text: string }[] = [];
  const assets: string[] = [];
  const seen = new Set<string>();
  const host = (() => { try { return new URL(base).host; } catch { return ""; } })();
  const anchor = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (let match = anchor.exec(html); match; match = anchor.exec(html)) {
    const url = absolute(base, match[1]!);
    if (!url || seen.has(url) || url === base) continue;
    seen.add(url);
    links.push({ url, text: stripTags(match[2]!).slice(0, 80) });
  }
  const asset = /<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  for (let match = asset.exec(html); match; match = asset.exec(html)) {
    const url = absolute(base, match[1]!);
    if (!url || seen.has(url)) continue;
    if (!/\.(?:m?js|css|json|map|wasm)(?:[?#]|$)/i.test(url) && !/<script/i.test(match[0]!)) continue;
    seen.add(url);
    assets.push(url);
  }
  // Same-site links first: digging deeper usually means the same site.
  links.sort((a, b) => Number(!a.url.includes(`//${host}`)) - Number(!b.url.includes(`//${host}`)));
  return { links: links.slice(0, MAX_LINKS), assets: assets.slice(0, MAX_LINKS) };
}

/**
 * Fetch a URL. `text` mode turns a page into readable text; `raw` returns the
 * source as served (a JavaScript file, JSON, CSS, HTML), so the agent can read
 * code. Both report the page's links and the files it loads, so the agent can
 * follow them. `offset` reads further into a long body.
 */
export async function webFetch(
  url: string,
  signal?: AbortSignal,
  options: { mode?: "text" | "raw"; offset?: number } = {},
): Promise<WebPage> {
  if (!/^https?:\/\//i.test(url)) throw new Error("URL must start with http:// or https://");
  const response = await fetch(url, {
    headers: { "user-agent": UA, accept: options.mode === "raw" ? "*/*" : "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.5" },
    redirect: "follow",
    signal: signal ?? AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`The page answered ${response.status}`);
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) throw new Error("That file is too large to read (over 2 MB).");
  if (/^(image|video|audio|font)\//.test(type) || type.includes("octet-stream") || type.includes("zip") || type.includes("pdf")) {
    throw new Error(`That is a ${type.split(";")[0]} file, not text; it can be downloaded with WebDownload but not read here.`);
  }
  const raw = await response.text();
  const body = raw.length > MAX_PAGE_BYTES ? raw.slice(0, MAX_PAGE_BYTES) : raw;
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const isHtml = type.includes("html") || (!type && /<html|<body|<div/i.test(body.slice(0, 2000)));
  const found = isHtml ? pageLinks(body, response.url) : { links: [], assets: [] };
  if (options.mode === "raw" || !isHtml) {
    const titleMatch = isHtml ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body) : null;
    return {
      url: response.url,
      title: titleMatch ? stripTags(titleMatch[1]!) : response.url,
      text: body.slice(offset, offset + MAX_RAW_CHARS),
      contentType: type.split(";")[0] || "text/plain",
      totalChars: body.length,
      ...found,
    };
  }
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = titleMatch ? stripTags(titleMatch[1]!) : response.url;
  const main = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");
  const text = stripTags(main).replace(/\n\s*\n+/g, "\n\n");
  return {
    url: response.url,
    title,
    text: text.slice(offset, offset + MAX_TEXT_CHARS) || "(No readable text on this page.)",
    contentType: type.split(";")[0] || "text/html",
    totalChars: text.length,
    ...found,
  };
}

export interface CrawledPage {
  url: string;
  title: string;
  excerpt: string;
  links: number;
  assets: string[];
  error?: string;
}

/**
 * Dig into a site: read the start page, then follow its links breadth-first
 * (same site unless told otherwise) up to `depth` hops and `maxPages` pages,
 * returning each page's title, an excerpt, and the files it loads.
 */
export async function webCrawl(
  startUrl: string,
  options: { depth?: number; maxPages?: number; sameSite?: boolean; match?: string } = {},
  signal?: AbortSignal,
): Promise<CrawledPage[]> {
  const depth = Math.max(0, Math.min(options.depth ?? 1, 3));
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 8, MAX_CRAWL_PAGES));
  const sameSite = options.sameSite ?? true;
  const matcher = options.match ? new RegExp(options.match, "i") : null;
  const startHost = new URL(startUrl).host;
  const queue: { url: string; hop: number }[] = [{ url: startUrl, hop: 0 }];
  const seen = new Set<string>([startUrl]);
  const pages: CrawledPage[] = [];
  while (queue.length && pages.length < maxPages) {
    if (signal?.aborted) break;
    const next = queue.shift()!;
    try {
      const page = await webFetch(next.url, signal);
      pages.push({ url: page.url, title: page.title, excerpt: page.text.slice(0, 1_500), links: page.links.length, assets: page.assets.slice(0, 10) });
      if (next.hop >= depth) continue;
      for (const link of page.links) {
        if (seen.has(link.url) || queue.length + pages.length >= maxPages * 3) continue;
        if (sameSite && !link.url.includes(`//${startHost}`)) continue;
        if (matcher && !matcher.test(link.url) && !matcher.test(link.text)) continue;
        seen.add(link.url);
        queue.push({ url: link.url, hop: next.hop + 1 });
      }
    } catch (error) {
      pages.push({ url: next.url, title: next.url, excerpt: "", links: 0, assets: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return pages;
}

/** Download a file as bytes (up to 20 MB), for saving into the agent's workspace. */
export async function webDownload(url: string, signal?: AbortSignal): Promise<{ url: string; bytes: Uint8Array; contentType: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error("URL must start with http:// or https://");
  const response = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, redirect: "follow", signal: signal ?? AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`The file answered ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > 20_000_000) throw new Error("That file is over 20 MB.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 20_000_000) throw new Error("That file is over 20 MB.");
  return { url: response.url, bytes, contentType: (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]! };
}
