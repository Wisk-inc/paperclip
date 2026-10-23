import { describe, expect, it } from "vitest";
import { openBracketStart, openLinkStart, settleStreamingMarkdown } from "./streaming-markdown";

describe("settleStreamingMarkdown", () => {
  it("closes bold and italics that are still open", () => {
    expect(settleStreamingMarkdown("Here's a quick plan for **Plan our produ")).toBe("Here's a quick plan for **Plan our produ**");
    expect(settleStreamingMarkdown("This is *really")).toBe("This is *really*");
  });

  it("leaves finished text alone", () => {
    const done = "Here's **bold** and *italic* and `code`.\n\n1. One\n2. Two";
    expect(settleStreamingMarkdown(done)).toBe(done);
  });

  it("closes an open code fence and inline code", () => {
    expect(settleStreamingMarkdown("Run this:\n\n```bash\nnpm i")).toBe("Run this:\n\n```bash\nnpm i\n```");
    expect(settleStreamingMarkdown("Use `pnpm dev")).toBe("Use `pnpm dev`");
  });

  it("shows a link's text while its address is still arriving", () => {
    expect(settleStreamingMarkdown("See [the docs](https://exa")).toBe("See the docs");
    expect(settleStreamingMarkdown("See [the do")).toBe("See the do");
  });

  it("does not treat a list marker as emphasis", () => {
    expect(settleStreamingMarkdown("Steps:\n\n* ")).toBe("Steps:\n\n* ");
    expect(settleStreamingMarkdown("Steps:\n- one\n- ")).toBe("Steps:\n- one\n- ");
  });
});

describe("settleStreamingMarkdown on split markers", () => {
  it("treats a trailing asterisk after an open bold as half of the closer", () => {
    expect(settleStreamingMarkdown("Plan for **launch day*")).toBe("Plan for **launch day**");
    expect(settleStreamingMarkdown("a **done** and *ital*")).toBe("a **done** and *ital*");
  });

  it("leaves link-looking text inside inline code alone", () => {
    expect(settleStreamingMarkdown("Call `foo[0](x` and then")).toBe("Call `foo[0](x` and then");
    expect(settleStreamingMarkdown("See [the docs](https://exa")).toBe("See the docs");
  });
});

describe("open link and bracket finders", () => {
  it("match the patterns they replace", () => {
    const alphabet = "[]()! a\n";
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 3000; run += 1) {
      const length = Math.floor(random() * 14);
      let text = "";
      for (let index = 0; index < length; index += 1) text += alphabet[Math.floor(random() * alphabet.length)];
      expect(openLinkStart(text), JSON.stringify(text)).toBe(/!?\[[^\]\n]*\]\([^)\n]*$/.exec(text)?.index ?? -1);
      expect(openBracketStart(text), JSON.stringify(text)).toBe(/\[[^\]\n]*$/.exec(text)?.index ?? -1);
    }
  });

  it("stays fast on a long line full of brackets", () => {
    const started = performance.now();
    settleStreamingMarkdown("[x ".repeat(20_000));
    settleStreamingMarkdown(`${"[a](b ".repeat(10_000)}\nend`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
