import { describe, expect, it } from "vitest";
import { pageLinks, readableText } from "./web.js";

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
