import { afterEach, describe, expect, it, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn(async (host: string) => [{ address: host === "metadata.evil.test" ? "169.254.169.254" : "93.184.216.34", family: 4 }]) }));
vi.mock("node:dns/promises", () => ({ lookup }));

const { isSearchChallenge, linkMatcher, pageLinks, parseBingRss, privateAddress, readableText, webCrawl, webDownload, webFetch, webSearch } = await import("./web.js");

type Hop = { status?: number; location?: string; body?: string | Uint8Array<ArrayBuffer>; contentType?: string; contentLength?: string };

/** A fetch stub that walks a list of hops, one per call, so redirects can be followed by hand. */
function stubFetch(hops: Hop[] | ((url: string) => Hop)) {
  const seen: string[] = [];
  let index = 0;
  const fetch = vi.fn(async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const hop = typeof hops === "function" ? hops(url) : (hops[index++] ?? hops[hops.length - 1]!);
    const headers: Record<string, string> = { "content-type": hop.contentType ?? "text/html" };
    if (hop.location) headers.location = hop.location;
    if (hop.contentLength) headers["content-length"] = hop.contentLength;
    const response = new Response(hop.status && hop.status >= 300 && hop.status < 400 ? null : (hop.body ?? "ok"), { status: hop.status ?? 200, headers });
    Object.defineProperty(response, "url", { value: url });
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  return seen;
}

afterEach(() => { vi.unstubAllGlobals(); lookup.mockClear(); });

describe("readable page text", () => {
  it("keeps the article and drops the site around it", () => {
    const story = "The national minimum wage rises to sixteen thousand dollars a week from June, the Labour Minister told the House on Tuesday. ".repeat(6);
    const html = `<html><head><title>Wage rises</title><script>var x=1</script></head><body>
      <header><nav><a href="/">Home</a><a href="/news">News</a></nav></header>
      <main>
        <article><h1>Wage rises</h1><p>${story}</p><aside>Related: <a href="/a">Other story</a></aside></article>
        <article class="teaser"><h3>Also on the site</h3><p>Teaser text about football.</p></article>
      </main>
      <footer>Copyright</footer>
    </body></html>`;
    const text = readableText(html);
    expect(text).toContain("Wage rises");
    expect(text).toContain("sixteen thousand dollars");
    expect(text).not.toContain("Home News");
    expect(text).not.toContain("Teaser text");
    expect(text).not.toContain("Related:");
    expect(text).not.toContain("Copyright");
  });

  it("falls back to the body when nothing is marked up", () => {
    const text = readableText("<html><body><nav>menu</nav><div><p>First paragraph.</p><ul><li>one</li><li>two</li></ul></div></body></html>");
    expect(text).toBe("First paragraph.\n\n- one\n- two");
  });

  it("still lists links and assets", () => {
    const found = pageLinks('<a href="/x">X</a><script src="/app.js"></script>', "https://example.com/");
    expect(found.links[0]).toEqual({ url: "https://example.com/x", text: "X" });
    expect(found.assets).toContain("https://example.com/app.js");
  });
});

describe("private address check", () => {
  it("names loopback, private, link-local, CGNAT, multicast and reserved as not public", () => {
    for (const ip of [
      "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.5.4", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "198.18.0.1", "192.0.2.5", "::1", "::", "fe80::1", "fc00::1", "fd12::3", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
      "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "2001:0::1",
    ]) {
      expect(privateAddress(ip)).toBe(true);
    }
  });

  it("lets ordinary public addresses through", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "198.51.99.1", "2606:4700::1111"]) {
      expect(privateAddress(ip)).toBe(false);
    }
  });
});

describe("SSRF and redirect safety", () => {
  it("refuses a host that resolves to a private address, before connecting", async () => {
    const seen = stubFetch([{ body: "secret" }]);
    await expect(webFetch("http://metadata.evil.test/latest/meta-data/")).rejects.toThrow(/private network/);
    expect(seen).toEqual([]);
  });

  it("refuses a literal loopback or link-local URL", async () => {
    stubFetch([{ body: "secret" }]);
    await expect(webFetch("http://127.0.0.1:3100/api/companies")).rejects.toThrow(/private network/);
    await expect(webDownload("http://[::ffff:169.254.169.254]/")).rejects.toThrow(/private network/);
    await expect(webFetch("http://localhost/admin")).rejects.toThrow(/private network/);
  });

  it("refuses a non-http scheme", async () => {
    stubFetch([{ body: "x" }]);
    await expect(webFetch("file:///etc/passwd")).rejects.toThrow(/http/);
  });

  it("checks each redirect hop, not just the first", async () => {
    const seen = stubFetch([{ status: 302, location: "http://169.254.169.254/latest/" }, { body: "secret" }]);
    await expect(webFetch("https://example.com/go")).rejects.toThrow(/private network/);
    expect(seen).toEqual(["https://example.com/go"]);
  });

  it("follows a public redirect by hand and reports the final URL", async () => {
    const seen = stubFetch([{ status: 301, location: "https://example.com/final" }, { body: "<title>Final</title><p>Here.</p>" }]);
    const page = await webFetch("https://example.com/start");
    expect(page.url).toBe("https://example.com/final");
    expect(seen).toEqual(["https://example.com/start", "https://example.com/final"]);
  });

  it("stops after too many redirects", async () => {
    let n = 0;
    stubFetch(() => ({ status: 302, location: `https://example.com/r${n++}` }));
    await expect(webFetch("https://example.com/loop")).rejects.toThrow(/redirected more than/);
  });
});

describe("streaming size caps", () => {
  it("refuses a download past 20 MB even when the length is not declared", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1_000_000)); },
    });
    const fetch = vi.fn(async (input: string | URL) => {
      const response = new Response(stream, { status: 200, headers: { "content-type": "application/octet-stream" } });
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    await expect(webDownload("https://example.com/huge.bin")).rejects.toThrow(/20 MB/);
  });

  it("trusts a declared length over the cap", async () => {
    stubFetch([{ body: new Uint8Array(10), contentType: "application/octet-stream", contentLength: "21000000" }]);
    await expect(webDownload("https://example.com/huge.bin")).rejects.toThrow(/20 MB/);
  });
});

describe("web crawl", () => {
  it("stays on the start host by exact comparison, not substring", async () => {
    const start = '<a href="https://example.com/a">A</a><a href="https://example.com.evil.test/b">B</a><a href="https://notexample.com/c">C</a>';
    const seen = stubFetch((url) => ({ body: url.endsWith("/local") ? start : "<p>leaf</p>" }));
    await webCrawl("https://example.com/local", { depth: 1, maxPages: 5 });
    expect(seen).toEqual(["https://example.com/local", "https://example.com/a"]);
  });

  it("treats a dangerous match pattern as plain text instead of running it", () => {
    // A nested quantifier would run for seconds as a regex; as plain text it is a quick substring test.
    const matcher = linkMatcher("(a+)+b");
    const start = Date.now();
    expect(matcher("a".repeat(4000))).toBe(false);
    expect(Date.now() - start).toBeLessThan(200);
    // It still matches as the literal text it is.
    expect(matcher("see (a+)+b here")).toBe(true);
    // A simple pattern still works as a regular expression.
    expect(linkMatcher("/local/[a-z]+")("https://example.com/local/story")).toBe(true);
  });
});

describe("numeric character references", () => {
  it("keeps the page when a reference names no character", () => {
    // The out-of-range reference becomes a space (collapsed here) rather than throwing and losing the page; a valid one still decodes.
    expect(readableText("<body><p>Budget &#99999999; passed &#65;.</p></body>")).toBe("Budget passed A.");
  });
});

const DDG_RESULTS = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=x">One &amp; only</a><a class="result__snippet" href="x">First snippet</a></div>
<div class="result"><a class="result__a" href="https://example.com/two">Two</a><a class="result__snippet" href="x">Second snippet</a></div>`;
const DDG_CHALLENGE = `<html><body><div id="anomaly-modal" class="anomaly-modal"><form id="challenge-form"><div class="anomaly-modal__title">Select all squares with traffic lights</div></form></div></body></html>`;
const BING_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>Bing: q</title>
<item><title>Jamaica - Wikipedia</title><link>https://en.wikipedia.org/wiki/Jamaica</link><description>Jamaica is an island country &amp; Commonwealth realm.</description></item>
<item><title><![CDATA[Tracked <b>result</b>]]></title><link>https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS90cmFja2Vk&amp;ntb=1</link><description><![CDATA[Through the click tracker.]]></description></item>
<item><title>No link</title><link></link><description>Dropped.</description></item>
</channel></rss>`;

describe("web search sources", () => {
  it("reads DuckDuckGo results and never asks Bing when DuckDuckGo answers", async () => {
    const seen = stubFetch((url) => (url.includes("duckduckgo") ? { body: DDG_RESULTS } : { status: 500 }));
    const results = await webSearch("example", 8);
    expect(results).toEqual([
      { title: "One & only", url: "https://example.com/one", snippet: "First snippet" },
      { title: "Two", url: "https://example.com/two", snippet: "Second snippet" },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("html.duckduckgo.com");
  });

  it("falls back to Bing when DuckDuckGo answers with its bot check", async () => {
    const seen = stubFetch((url) => (url.includes("duckduckgo") ? { status: 202, body: DDG_CHALLENGE } : { body: BING_RSS, contentType: "text/xml" }));
    const results = await webSearch("jamaica", 8);
    expect(results).toEqual([
      { title: "Jamaica - Wikipedia", url: "https://en.wikipedia.org/wiki/Jamaica", snippet: "Jamaica is an island country & Commonwealth realm." },
      { title: "Tracked result", url: "https://example.com/tracked", snippet: "Through the click tracker." },
    ]);
    expect(seen.map((url) => new URL(url).host)).toEqual(["html.duckduckgo.com", "www.bing.com"]);
    expect(seen[1]).toContain("format=rss");
    expect(seen[1]).toContain("q=jamaica");
  });

  it("falls back to Bing when DuckDuckGo answers an error status", async () => {
    const seen = stubFetch((url) => (url.includes("duckduckgo") ? { status: 503, body: "busy" } : { body: BING_RSS, contentType: "text/xml" }));
    const results = await webSearch("jamaica", 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe("https://en.wikipedia.org/wiki/Jamaica");
    expect(seen).toHaveLength(2);
  });

  it("names every source's answer when all of them fail", async () => {
    stubFetch((url) => (url.includes("duckduckgo") ? { status: 202, body: DDG_CHALLENGE } : { status: 403, body: "no" }));
    await expect(webSearch("jamaica")).rejects.toThrow("Search failed: DuckDuckGo answered with a bot check; Bing answered 403");
  });

  it("returns no results, not an error, when every source answers properly with nothing", async () => {
    const seen = stubFetch((url) => (url.includes("duckduckgo") ? { body: "<html><body><div class=\"no-results\">No results.</div></body></html>" } : { body: "<rss><channel></channel></rss>", contentType: "text/xml" }));
    await expect(webSearch("xqzv nonsense")).resolves.toEqual([]);
    expect(seen).toHaveLength(2);
  });

  it("treats a real empty result page as empty, not as a bot check", () => {
    expect(isSearchChallenge("<html><body><div class=\"no-results\">No results.</div></body></html>")).toBe(false);
    expect(isSearchChallenge(DDG_CHALLENGE)).toBe(true);
    expect(parseBingRss("<rss><channel></channel></rss>")).toEqual([]);
  });

  it("stops at once when the caller aborts, instead of trying the next source", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      seen.push(String(input));
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    }));
    await expect(webSearch("jamaica", 8, controller.signal)).rejects.toThrow(/aborted/);
    expect(seen).toHaveLength(1);
  });
});
