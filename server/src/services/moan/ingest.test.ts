import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookup, replacePage, webDownload, webFetch } = vi.hoisted(() => ({
  lookup: vi.fn(),
  replacePage: vi.fn(),
  webDownload: vi.fn(),
  webFetch: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("../../adapters/free-models/web.js", () => ({ webDownload, webFetch }));
vi.mock("../../adapters/free-models/office.js", () => ({ readDocument: vi.fn() }));
vi.mock("./store.js", () => ({
  replacePage,
  sourcePageCount: vi.fn(async () => 0),
  storedPage: vi.fn(async () => null),
  touchSource: vi.fn(async () => undefined),
}));

import { ingestSource } from "./ingest.js";
import type { MoanSource } from "./sources.js";

const db = {} as never;
const body = "The Bank of Jamaica held its policy rate this week. ".repeat(20);

function page(url: string, links: Array<{ url: string; text: string }> = [], finalUrl = url) {
  return { url: finalUrl, title: `Page ${url}`, text: body, contentType: "text/html", totalChars: body.length, links, assets: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every name is a public site, except one that resolves into a private network.
  lookup.mockImplementation(async (host: string) => [{ address: host === "rebind.example" ? "10.0.0.5" : "93.184.216.34", family: 4 }]);
  replacePage.mockResolvedValue("stored");
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("Moan ingest", () => {
  it("follows only links on the crawled site itself", async () => {
    const article = "https://radiojamaicanewsonline.com/local/police-probe-shooting-in-st-james";
    webFetch.mockImplementation(async (url: string) => page(url, url === "https://radiojamaicanewsonline.com/local" ? [
      { url: article, text: "Police probe shooting" },
      { url: `https://www.facebook.com/sharer/sharer.php?u=${article}`, text: "Share" },
      { url: `https://radiojamaicanewsonline.com.evil.example/?next=//radiojamaicanewsonline.com/local/police-probe-shooting-in-st-james`, text: "Look-alike" },
    ] : []));
    const source: MoanSource = { id: "rjr", name: "Radio Jamaica News", topic: "news", kind: "crawl", url: "https://radiojamaicanewsonline.com/local", everyMinutes: 180, maxItems: 15, match: "radiojamaicanewsonline\\.com/(local|business|regional|sport|politics)/[a-z0-9-]{12,}" };

    const result = await ingestSource(db, source);

    expect(webFetch.mock.calls.map(([url]) => url)).toEqual(["https://radiojamaicanewsonline.com/local", article]);
    expect(result).toMatchObject({ items: 2, stored: 2, error: null });
  });

  it("reads feed links into the index only from public sites, before and after redirects", async () => {
    const links = [
      "http://127.0.0.1:3100/api/companies",
      "http://localhost:3100/api/health",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:3100/api/companies",
      "http://rebind.example/admin",
      "https://jis.gov.jm/redirects-home",
      "https://jis.gov.jm/budget-debate-opens",
    ];
    const feed = `<rss><channel>${links.map((link, i) => `<item><title>Item ${i}</title><link>${link}</link></item>`).join("")}</channel></rss>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(feed, { status: 200 })));
    webFetch.mockImplementation(async (url: string) => page(url, [], url.endsWith("redirects-home") ? "http://192.168.1.1/admin" : url));
    const source: MoanSource = { id: "jis", name: "Jamaica Information Service", topic: "government", kind: "rss", url: "https://jis.gov.jm/feed/", everyMinutes: 180, maxItems: 20 };

    const result = await ingestSource(db, source);

    expect(webFetch.mock.calls.map(([url]) => url)).toEqual(["https://jis.gov.jm/redirects-home", "https://jis.gov.jm/budget-debate-opens"]);
    expect(replacePage.mock.calls.map(([, stored]) => (stored as { url: string }).url)).toEqual(["https://jis.gov.jm/budget-debate-opens"]);
    expect(result).toMatchObject({ items: 7, stored: 1, error: null });
  });

  it("stores a page whose text carries NUL characters, which Postgres text cannot hold", async () => {
    webFetch.mockImplementation(async (url: string) => ({ ...page(url), title: "Jamaica\u0000", text: `${body}\u0000${body}` }));
    const source: MoanSource = { id: "wiki-jamaica", name: "Wikipedia: Jamaica", topic: "history", kind: "page", url: "https://en.wikipedia.org/wiki/Jamaica", everyMinutes: 43_200, maxItems: 1 };

    await ingestSource(db, source);

    const stored = replacePage.mock.calls[0]![1] as { title: string; chunks: string[] };
    expect(stored.title).toBe("Jamaica");
    expect(stored.chunks.join("")).not.toContain("\u0000");
  });
});
