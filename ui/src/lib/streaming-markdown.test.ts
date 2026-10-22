import { describe, expect, it } from "vitest";
import { settleStreamingMarkdown } from "./streaming-markdown";

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
