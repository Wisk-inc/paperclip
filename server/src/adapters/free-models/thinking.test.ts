import { describe, expect, it } from "vitest";
import { formatWithThinking, readThinkingLevel, splitThinking, thinkingInstruction } from "./thinking.js";

describe("free model thinking", () => {
  it("accepts only the levels the picker offers", () => {
    expect(readThinkingLevel("high")).toBe("high");
    expect(readThinkingLevel("xhigh")).toBe("xhigh");
    expect(readThinkingLevel("")).toBeNull();
    expect(readThinkingLevel("max")).toBeNull();
  });

  it("asks harder levels to think longer and to tag the thinking", () => {
    expect(thinkingInstruction("low")).toContain("briefly");
    expect(thinkingInstruction("xhigh")).toContain("verify every step");
    expect(thinkingInstruction("medium")).toContain("<thinking></thinking>");
  });

  it("separates tagged thinking from the answer, preferring native reasoning", () => {
    expect(splitThinking("<thinking>36 - 7 = 29</thinking>\n\n29 apples.", "")).toEqual({ thinking: "36 - 7 = 29", answer: "29 apples." });
    expect(splitThinking("<thinking>tagged</thinking>Answer", "native chain")).toEqual({ thinking: "native chain", answer: "Answer" });
    expect(splitThinking("Just an answer", "")).toEqual({ thinking: "", answer: "Just an answer" });
  });

  it("quotes the thinking above the answer and trims long chains", () => {
    expect(formatWithThinking("step one\nstep two", "Done.")).toBe("> **Thinking**\n>\n> step one\n> step two\n\nDone.");
    expect(formatWithThinking("", "Done.")).toBe("Done.");
    expect(formatWithThinking("x".repeat(2000), "Done.")).toContain("x…\n\nDone.");
  });
});
