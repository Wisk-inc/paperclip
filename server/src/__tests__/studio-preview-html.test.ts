import { describe, expect, it } from "vitest";
import { injectIntoPreviewHtml, PREVIEW_STORAGE_SHIM } from "../routes/studio.js";

const TAGS = "<base href=\"/p/\"><script>shim</script>";

describe("Studio preview HTML", () => {
  it("puts the tags first in the head, not in a <header>", () => {
    const html = "<!doctype html><html><head><title>To-do</title></head><body><header>Top</header></body></html>";
    expect(injectIntoPreviewHtml(html, TAGS)).toBe(`<!doctype html><html><head>${TAGS}<title>To-do</title></head><body><header>Top</header></body></html>`);
  });

  it("goes after <html> when the page has no head, even with a <header class>", () => {
    const html = "<!doctype html><html lang=\"en\"><body><header class=\"top\">Top</header></body></html>";
    expect(injectIntoPreviewHtml(html, TAGS)).toBe(`<!doctype html><html lang="en">${TAGS}<body><header class="top">Top</header></body></html>`);
  });

  it("keeps the doctype first so the page stays out of quirks mode", () => {
    expect(injectIntoPreviewHtml("<!DOCTYPE html>\n<header>Hi</header>", TAGS)).toBe(`<!DOCTYPE html>${TAGS}\n<header>Hi</header>`);
    expect(injectIntoPreviewHtml("<p>bare</p>", TAGS)).toBe(`${TAGS}<p>bare</p>`);
  });

  it("stands in for storage only where the browser refuses it", () => {
    expect(PREVIEW_STORAGE_SHIM).toMatch(/^<script>/);
    expect(PREVIEW_STORAGE_SHIM).toContain("localStorage");
    expect(PREVIEW_STORAGE_SHIM).toContain("sessionStorage");
    // Only on a throwing getter: a page with working storage keeps it.
    expect(PREVIEW_STORAGE_SHIM).toContain("try{void window[n].length}catch(e)");
  });
});
