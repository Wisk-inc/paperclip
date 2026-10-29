/**
 * Keyless web access for free-model agents: a search that scrapes DuckDuckGo's
 * HTML results, and a fetch that turns a page into readable text. No API key,
 * so it works the same on a phone as on a server.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
const MAX_DOWNLOAD_BYTES = 20_000_000;
const MAX_REDIRECTS = 5;
/** A crawl filter is a regular expression only while it stays this short; see linkMatcher. */
const MAX_PATTERN_CHARS = 100;
/** How much of a link a crawl filter reads. */
const MAX_MATCH_INPUT = 500;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A numeric character reference; one naming no storable character (NUL, past U+10FFFF) becomes a space. */
function codePoint(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => codePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => codePoint(parseInt(code, 16)))
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
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
  const host = hostOf(base);
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
  const sameSite = links.filter((link) => hostOf(link.url) === host);
  const elsewhere = links.filter((link) => hostOf(link.url) !== host);
  return { links: [...sameSite, ...elsewhere].slice(0, MAX_LINKS), assets: assets.slice(0, MAX_LINKS) };
}

/** The eight 16-bit groups of an IPv6 address, a dotted IPv4 tail included. */
function ipv6Groups(ip: string): number[] {
  const text = ip.split("%")[0]!.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) =>
    `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`);
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  if (tail === undefined) return left.map((group) => parseInt(group, 16));
  const right = tail ? tail.split(":") : [];
  return [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right].map((group) => parseInt(group, 16));
}

/**
 * True for an address on this device or a private network rather than the
 * public web: loopback, private, link-local (the cloud metadata address among
 * them), shared CGNAT, multicast, reserved and unspecified, in IPv4 or IPv6.
 * An IPv4 address carried inside IPv6 is judged as itself.
 */
export function privateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113);
  }
  if (isIP(ip) !== 6) return true;
  const groups = ipv6Groups(ip);
  const ipv4 = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  // IPv4-compatible (:: and ::1 among them), IPv4-mapped, NAT64 and 6to4 addresses lead to an IPv4 address.
  if (zeros(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) return privateAddress(ipv4(groups[6]!, groups[7]!));
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) return privateAddress(ipv4(groups[6]!, groups[7]!));
  if (groups[0] === 0x2002) return privateAddress(ipv4(groups[1]!, groups[2]!));
  // Only global unicast (2000::/3) is the web, less its Teredo and documentation ranges.
  return (groups[0]! & 0xe000) !== 0x2000 || (groups[0] === 0x2001 && (groups[1] === 0 || groups[1] === 0xdb8));
}

/** Refuses a URL the web tools must not open: anything but http(s), or a host that is or resolves to this device or a private network. */
async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must start with http:// or https://");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const addresses = isIP(host) ? [host]
    : host === "localhost" || host.endsWith(".localhost") ? ["127.0.0.1"]
    : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (addresses.some(privateAddress)) throw new Error(`${url.host} is on this device or a private network; the web tools only open public sites.`);
}

/** A GET that follows redirects itself, checking that each hop is a public site before connecting to it. */
async function fetchPublic(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<{ response: Response; url: string }> {
  let current = new URL(url);
  for (let hop = 0; ; hop += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current.toString(), { ...init, redirect: "manual" });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return { response, url: current.toString() };
    await response.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error(`The address redirected more than ${MAX_REDIRECTS} times.`);
    current = new URL(location, current);
  }
}

/**
 * The body, read only as far as `max` bytes, so a huge or endless answer never
 * fills memory: past it the rest is cut off, or refused when `tooLarge` names why.
 */
async function readBody(response: Response, max: number, tooLarge?: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      await reader.cancel().catch(() => undefined);
      if (tooLarge) throw new Error(tooLarge);
      chunks.push(value.subarray(0, max - size));
      size = max;
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * A crawl filter the model wrote, as a test on link text and URLs. It runs as
 * a regular expression only when that is a simple one (short, at most one
 * open-ended repeat, no repeated groups or back-references), because a
 * pathological expression would hold up the whole server; anything else,
 * an invalid expression included, matches as plain text.
 */
export function linkMatcher(pattern: string): (text: string) => boolean {
  const bare = pattern.replace(/\\./g, "");
  const openEnded = (bare.match(/[*+]|\{\d/g) ?? []).length;
  const optional = (bare.match(/\?/g) ?? []).length;
  const simple = pattern.length <= MAX_PATTERN_CHARS && openEnded <= 1 && openEnded + optional <= 3
    && !/\)(?:[*+?]|\{\d)/.test(bare) && !/\\(?:[1-9]|k<)/.test(pattern);
  if (simple) {
    try {
      const regex = new RegExp(pattern, "i");
      return (text) => regex.test(text.slice(0, MAX_MATCH_INPUT));
    } catch {
      // Not a valid expression: matched as plain text below.
    }
  }
  const needle = pattern.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
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
  options: { mode?: "text" | "raw"; offset?: number; maxChars?: number } = {},
): Promise<WebPage> {
  if (!/^https?:\/\//i.test(url)) throw new Error("URL must start with http:// or https://");
  const { response, url: pageUrl } = await fetchPublic(url, {
    headers: { "user-agent": UA, accept: options.mode === "raw" ? "*/*" : "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.5" },
    signal: signal ?? AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`The page answered ${response.status}`);
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) throw new Error("That file is too large to read (over 2 MB).");
  if (/^(image|video|audio|font)\//.test(type) || type.includes("octet-stream") || type.includes("zip") || type.includes("pdf")) {
    throw new Error(`That is a ${type.split(";")[0]} file, not text; it can be downloaded with WebDownload but not read here.`);
  }
  const body = new TextDecoder().decode(await readBody(response, MAX_PAGE_BYTES));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const isHtml = type.includes("html") || (!type && /<html|<body|<div/i.test(body.slice(0, 2000)));
  const found = isHtml ? pageLinks(body, pageUrl) : { links: [], assets: [] };
  if (options.mode === "raw" || !isHtml) {
    const titleMatch = isHtml ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body) : null;
    return {
      url: pageUrl,
      title: titleMatch ? stripTags(titleMatch[1]!) : pageUrl,
      text: body.slice(offset, offset + (options.maxChars ?? MAX_RAW_CHARS)),
      contentType: type.split(";")[0] || "text/plain",
      totalChars: body.length,
      ...found,
    };
  }
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = titleMatch ? stripTags(titleMatch[1]!) : pageUrl;
  const text = readableText(body);
  return {
    url: pageUrl,
    title,
    text: text.slice(offset, offset + (options.maxChars ?? MAX_TEXT_CHARS)) || "(No readable text on this page.)",
    contentType: type.split(";")[0] || "text/html",
    totalChars: text.length,
    ...found,
  };
}

/** Drops whole elements of a kind (nested ones too, roughly) from HTML. */
function dropElements(html: string, names: string[]): string {
  let out = html;
  for (const name of names) {
    out = out.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, "gi"), " ");
  }
  return out;
}

/**
 * The readable text of a page: the article when the page marks one (the
 * longest <article>, else <main>), with navigation, headers, footers,
 * sidebars, forms and scripts left out, so an article reads as the article
 * and not the site around it.
 */
export function readableText(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Block ends become line breaks and paragraph breaks survive, so a page
  // chunks and reads the way it was laid out.
  const toText = (fragment: string) => decodeEntities(
    fragment
      .replace(/<\/(p|div|section|article|h[1-6]|blockquote|pre|figcaption|dd|dt)>/gi, "\n\n")
      .replace(/<\/(li|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<h([1-6])[^>]*>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chrome = ["nav", "aside", "form", "footer", "header"];
  const longest = (fragments: string[]) => fragments
    .map((fragment) => toText(dropElements(fragment, chrome)))
    .filter((text) => text.length >= 400)
    .sort((a, b) => b.length - a.length)[0];
  // The longest <article> is the story (the others are teasers); <main> is the
  // next best guess; the body is the last.
  const article = longest([...cleaned.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((match) => match[1]!));
  if (article) return article;
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(cleaned)?.[1];
  const mainText = main ? longest([main]) : undefined;
  if (mainText) return mainText;
  const bodyOnly = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(cleaned)?.[1] ?? cleaned;
  return toText(dropElements(bodyOnly, chrome));
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
  const matcher = options.match ? linkMatcher(options.match) : null;
  // The site is the start page's host, and the one it redirects to (example.com to www.example.com).
  const sites = new Set([new URL(startUrl).host]);
  const queue: { url: string; hop: number }[] = [{ url: startUrl, hop: 0 }];
  const seen = new Set<string>([startUrl]);
  const pages: CrawledPage[] = [];
  while (queue.length && pages.length < maxPages) {
    if (signal?.aborted) break;
    const next = queue.shift()!;
    try {
      const page = await webFetch(next.url, signal);
      if (next.hop === 0) sites.add(hostOf(page.url));
      pages.push({ url: page.url, title: page.title, excerpt: page.text.slice(0, 1_500), links: page.links.length, assets: page.assets.slice(0, 10) });
      if (next.hop >= depth) continue;
      for (const link of page.links) {
        if (seen.has(link.url) || queue.length + pages.length >= maxPages * 3) continue;
        if (sameSite && !sites.has(hostOf(link.url))) continue;
        if (matcher && !matcher(link.url) && !matcher(link.text)) continue;
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
  const { response, url: fileUrl } = await fetchPublic(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: signal ?? AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`The file answered ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw new Error("That file is over 20 MB.");
  const bytes = await readBody(response, MAX_DOWNLOAD_BYTES, "That file is over 20 MB.");
  return { url: fileUrl, bytes, contentType: (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]! };
}
