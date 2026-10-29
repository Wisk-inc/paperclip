import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  buildDocument,
  buildPresentation,
  buildSpreadsheet,
  documentFileName,
  documentKind,
  htmlToMarkdown,
  inlineRuns,
  parseMarkdownBlocks,
  readDocument,
} from "./office.js";

describe("office documents", () => {
  it("builds a spreadsheet and reads it back as tables", async () => {
    const bytes = await buildSpreadsheet({
      title: "Sales",
      sheets: [
        { name: "Q1", columns: ["Parish", "Sales", "Note"], rows: [["Kingston", 120, "ok"], ["St. James", 80.5, null], ["Total", "=SUM(B2:B3)", ""]] },
        { name: "Empty" },
      ],
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const read = await readDocument(bytes, "sales.xlsx");
    expect(read.kind).toBe("xlsx");
    expect(read.summary).toBe("2 sheets");
    expect(read.text).toContain("## Sheet: Q1");
    expect(read.text).toContain("| Parish | Sales | Note |");
    expect(read.text).toContain("| Kingston | 120 | ok |");
    expect(read.text).toContain("| St. James | 80.5 |");
    // A formula with no cached result reads back as the formula itself.
    expect(read.text).toContain("=SUM(B2:B3)");
  });

  it("builds a themed presentation with bullets, a table, a chart and notes, and reads it back", async () => {
    const bytes = await buildPresentation({
      title: "Jamaica at a glance",
      subtitle: "A short deck",
      theme: "jamaica",
      slides: [
        { title: "Parishes", bullets: ["14 parishes", "3 counties"], notes: "Mention Cornwall, Middlesex and Surrey." },
        { title: "Numbers", table: { columns: ["Year", "Visitors"], rows: [["2023", "4.1M"], ["2024", "4.3M"]] } },
        { title: "Trend", chart: { type: "bar", categories: ["2022", "2023", "2024"], series: [{ name: "Visitors (M)", values: [3.3, 4.1, 4.3] }] } },
      ],
    }, new Map([[0, { bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png" }]]));
    expect(bytes.byteLength).toBeGreaterThan(5000);
    const read = await readDocument(bytes, "deck.pptx");
    expect(read.kind).toBe("pptx");
    expect(read.summary).toBe("4 slides");
    expect(read.text).toContain("Jamaica at a glance");
    expect(read.text).toContain("## Slide 2: Parishes");
    expect(read.text).toContain("- 14 parishes");
    expect(read.text).toContain("Notes: Mention Cornwall, Middlesex and Surrey.");
    expect(read.text).toContain("Visitors");
  });

  it("builds a document from Markdown and reads it back with its structure", async () => {
    const bytes = await buildDocument({
      title: "Lease agreement",
      markdown: [
        "# Terms",
        "",
        "The **tenant** pays *monthly*. See [the act](https://moj.gov.jm/laws).",
        "",
        "## Duties",
        "",
        "- Keep the premises clean",
        "- Pay on time",
        "",
        "1. First step",
        "2. Second step",
        "",
        "> Signed in Kingston",
        "",
        "| Item | Amount |",
        "| --- | --- |",
        "| Rent | 50,000 |",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "---",
        "",
        "Final paragraph.",
      ].join("\n"),
    });
    expect(bytes.byteLength).toBeGreaterThan(2000);
    const read = await readDocument(bytes, "lease.docx");
    expect(read.kind).toBe("docx");
    expect(read.text).toContain("# Terms");
    expect(read.text).toContain("**tenant**");
    expect(read.text).toContain("[the act](https://moj.gov.jm/laws)");
    expect(read.text).toContain("## Duties");
    expect(read.text).toContain("- Keep the premises clean");
    expect(read.text).toContain("| Rent | 50,000 |");
    expect(read.text).toContain("const x = 1;");
    expect(read.text).toContain("Final paragraph.");
  });

  it("parses Markdown blocks and inline runs", () => {
    const blocks = parseMarkdownBlocks("# Title\n\nPara one\nstill one\n\n- a\n- b\n\n1) one\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n\n> quote\n\n***");
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "bullets", "bullets", "table", "code", "quote", "rule"]);
    expect(blocks[1]).toEqual({ type: "paragraph", text: "Para one still one" });
    expect(blocks[2]).toEqual({ type: "bullets", items: ["a", "b"], ordered: false });
    expect(blocks[3]).toEqual({ type: "bullets", items: ["one"], ordered: true });
    expect(blocks[4]).toEqual({ type: "table", columns: ["A", "B"], rows: [["1", "2"]] });
    expect(inlineRuns("plain **bold** and `code` then [x](http://y) *it*")).toEqual([
      { text: "plain " }, { text: "bold", bold: true }, { text: " and " }, { text: "code", code: true }, { text: " then " }, { text: "x", link: "http://y" }, { text: " " }, { text: "it", italic: true },
    ]);
  });

  it("turns converter HTML into Markdown", () => {
    const markdown = htmlToMarkdown("<h1>Hi</h1><p>A <strong>b</strong> &amp; <em>c</em> &#99999999; d &#65;</p><ul><li>one</li><li>two</li></ul><table><tr><th>X</th><th>Y</th></tr><tr><td>1</td><td>2</td></tr></table>");
    expect(markdown).toContain("# Hi");
    // &amp; stays a literal ampersand, a valid reference decodes to its character, and one naming no character
    // becomes a space rather than throwing and losing the text.
    expect(markdown).toContain("A **b** & *c*");
    expect(markdown).toContain("d A");
    expect(markdown).not.toContain("99999999");
    expect(markdown).toContain("- one\n- two");
    expect(markdown).toContain("| X | Y |\n| --- | --- |\n| 1 | 2 |");
  });

  it("refuses a zip bomb before unpacking it", async () => {
    // 110 MB of zeros compresses to a tiny archive; inflating it would exhaust memory, so it is refused on the declared size alone.
    const bomb = zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(110_000_000) }, { level: 6 });
    expect(bomb.length).toBeLessThan(1_000_000);
    for (const name of ["bomb.xlsx", "bomb.pptx", "bomb.docx"]) {
      await expect(readDocument(bomb, name)).rejects.toThrow(/unpacks to more than 100 MB/);
    }
    // A damaged archive is reported plainly, not left to crash a reader.
    await expect(readDocument(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]), "torn.docx")).rejects.toThrow(/could not be opened/);
  });

  it("reads CSV and text, pages long content, and names files safely", async () => {
    const csv = await readDocument(Buffer.from("a,b\n1,2\n"), "data.csv");
    expect(csv.kind).toBe("csv");
    expect(csv.text).toBe("a,b\n1,2\n");
    const long = await readDocument(Buffer.from("x".repeat(5000)), "notes.txt", { maxChars: 1000, offset: 4500 });
    expect(long.text).toHaveLength(500);
    expect(long.totalChars).toBe(5000);
    expect(long.shown).toBe(5000);
    expect(documentKind("report.PDF")).toBe("pdf");
    expect(documentKind("blob", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(documentKind("photo.png", "image/png")).toBeNull();
    expect(documentFileName("Q1 report.xls", "xlsx", "spreadsheet")).toBe("Q1 report.xlsx");
    expect(documentFileName("../../bad:name?", "docx", "document")).toBe(".. .. bad name.docx");
    expect(documentFileName("", "pptx", "presentation")).toBe("presentation.pptx");
  });

  it("reads a PDF page by page", async () => {
    // A minimal one-page PDF with a text object; pdf.js rebuilds the cross-reference table itself.
    const pdf = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
      "4 0 obj << /Length 60 >> stream",
      "BT /F1 18 Tf 20 100 Td (Wah gwaan Jamaica) Tj ET",
      "endstream endobj",
      "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
      "trailer << /Root 1 0 R >>",
      "%%EOF",
    ].join("\n");
    const read = await readDocument(Buffer.from(pdf, "latin1"), "hello.pdf");
    expect(read.kind).toBe("pdf");
    expect(read.text).toContain("## Page 1");
    expect(read.text).toContain("Wah gwaan Jamaica");
  });
});
