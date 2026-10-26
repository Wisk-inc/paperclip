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

/** Fetch a page (or JSON/text file) and return readable text, capped. */
export async function webFetch(url: string, signal?: AbortSignal): Promise<{ title: string; text: string; url: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error("URL must start with http:// or https://");
  const response = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/json,text/plain" },
    redirect: "follow",
    signal: signal ?? AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`The page answered ${response.status}`);
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) throw new Error("That page is too large to read.");
  const raw = await response.text();
  const body = raw.length > MAX_PAGE_BYTES ? raw.slice(0, MAX_PAGE_BYTES) : raw;
  if (type.includes("json") || type.includes("text/plain") || (!type.includes("html") && body.trim().startsWith("{"))) {
    return { url: response.url, title: url, text: body.slice(0, MAX_TEXT_CHARS) };
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
  return { url: response.url, title, text: text.slice(0, MAX_TEXT_CHARS) || "(No readable text on this page.)" };
}
