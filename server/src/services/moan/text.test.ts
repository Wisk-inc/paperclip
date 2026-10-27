import { describe, expect, it } from "vitest";
import { chunkText, formatContext, hashText, parseFeed, queryTerms, timeAgo, trimReferences } from "./text.js";

describe("moan knowledge text helpers", () => {
  it("reads RSS items with CDATA titles and dates", () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>JIS</title>
      <item><title><![CDATA[Budget tabled &amp; debated]]></title><link>https://jis.gov.jm/budget</link><pubDate>Tue, 10 Mar 2026 14:00:00 GMT</pubDate><description><![CDATA[<p>The <b>minister</b> opened the debate.</p>]]></description></item>
      <item><title>No link</title><description>skip</description></item>
      <item><title>Second</title><guid>https://jis.gov.jm/second</guid></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: "Budget tabled & debated", link: "https://jis.gov.jm/budget", publishedAt: new Date("2026-03-10T14:00:00Z"), summary: "The minister opened the debate." });
    expect(items[1]!.link).toBe("https://jis.gov.jm/second");
    expect(items[1]!.publishedAt).toBeNull();
  });

  it("reads Atom entries", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Rates held</title><link rel="alternate" href="https://boj.org.jm/rates?a=1&amp;b=2"/><updated>2026-02-01T09:30:00Z</updated><summary>The policy rate stays.</summary></entry></feed>`;
    expect(parseFeed(xml)).toEqual([{ title: "Rates held", link: "https://boj.org.jm/rates?a=1&b=2", publishedAt: new Date("2026-02-01T09:30:00Z"), summary: "The policy rate stays." }]);
    expect(parseFeed("<html>not a feed</html>")).toEqual([]);
  });

  it("chunks on paragraph and sentence edges within the size and count limits", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}. ${"Words and more words. ".repeat(20)}`);
    const chunks = chunkText(paragraphs.join("\n\n"), { size: 1_000, max: 5 });
    expect(chunks).toHaveLength(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1_500);
    expect(chunks[0]).toContain("Paragraph 1.");
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText("short")).toEqual([]);
    const long = chunkText("x".repeat(5_000), { size: 1_000, max: 10 });
    expect(long.length).toBeGreaterThanOrEqual(3);
    expect(hashText("a")).not.toBe(hashText("b"));
    expect(hashText("same")).toBe(hashText("same"));
  });

  it("turns a Patois question into search words", () => {
    expect(queryTerms("Wah gwaan, mi waan know bout di new Road Traffic Act fine dem fi speeding inna Kingston?")).toEqual(["road", "traffic", "act", "fine", "speeding", "kingston"]);
    expect(queryTerms("Tell me about the minimum wage")).toEqual(["minimum", "wage"]);
    expect(queryTerms("")).toEqual([]);
  });

  it("formats passages with source, date, link and excerpt, without repeating a page", () => {
    const context = formatContext([
      { sourceName: "The Gleaner", url: "https://jamaica-gleaner.com/a", title: "Minimum wage rises", publishedAt: new Date("2026-06-01T00:00:00Z"), content: "The national minimum wage moves to   J$16,000.\n\nMore detail." },
      { sourceName: "The Gleaner", url: "https://jamaica-gleaner.com/a", title: "Minimum wage rises", publishedAt: null, content: "duplicate chunk" },
      { sourceName: "Laws", url: "https://moj.gov.jm/laws/mw.pdf", title: "", publishedAt: null, content: "x".repeat(2_000) },
    ]);
    expect(context).toContain("- [The Gleaner · 2026-06-01] Minimum wage rises\n  https://jamaica-gleaner.com/a\n  The national minimum wage moves to J$16,000. More detail.");
    expect(context.match(/jamaica-gleaner\.com\/a/g)).toHaveLength(1);
    expect(context).toContain("- [Laws] https://moj.gov.jm/laws/mw.pdf");
    expect(context.length).toBeLessThan(1_500);
    expect(formatContext([])).toBe("");
  });

  it("cuts a reference page before its citation lists, but not a short one", () => {
    const body = "Hurricane Melissa was a Category 5 storm. ".repeat(60);
    const page = `${body}\n\nSee also\n\n- List of hurricanes\n\nReferences\n\n- ↑ Masters, Jeff (2025). Melissa Melissa Melissa.`;
    expect(trimReferences(page)).toBe(body.trim());
    expect(trimReferences("Short\n\nReferences\n\n- one")).toBe("Short\n\nReferences\n\n- one");
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-03-10T12:00:00Z");
    expect(timeAgo(new Date(now - 30_000), now)).toBe("just now");
    expect(timeAgo(new Date(now - 15 * 60_000), now)).toBe("15 minutes ago");
    expect(timeAgo(new Date(now - 3 * 3_600_000), now)).toBe("3 hours ago");
    expect(timeAgo("2026-03-01T12:00:00Z", now)).toBe("9 days ago");
    expect(timeAgo(null)).toBe("never");
  });
});
