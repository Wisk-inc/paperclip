import { describe, expect, it } from "vitest";
import { createThinkingTagSplitter, readThinkingLevel, splitThinking, thinkingInstruction } from "./thinking.js";

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

});

describe("thinking tag splitter", () => {
  function run(chunks: string[]) {
    const splitter = createThinkingTagSplitter();
    const out: { channel: string; text: string }[] = [];
    for (const chunk of chunks) out.push(...splitter.push(chunk));
    out.push(...splitter.flush());
    const join = (channel: string) => out.filter((p) => p.channel === channel).map((p) => p.text).join("");
    return { text: join("text"), thinking: join("thinking") };
  }

  it("routes tagged thinking to the thinking channel and the rest to text", () => {
    expect(run(["<thinking>36-7=29</thinking>", "29 apples."])).toEqual({ thinking: "36-7=29", text: "29 apples." });
  });

  it("handles a tag split across deltas", () => {
    expect(run(["<think", "ing>a", "b</thin", "king>answer"])).toEqual({ thinking: "ab", text: "answer" });
  });

  it("passes plain text through untouched", () => {
    expect(run(["Just ", "an answer."])).toEqual({ thinking: "", text: "Just an answer." });
  });

  it("says when a reply ended inside a thinking tag it never closed", () => {
    const open = createThinkingTagSplitter();
    open.push("<think");
    open.push("ing>29 apples");
    open.flush();
    expect(open.unclosed).toBe(true);
    const closed = createThinkingTagSplitter();
    closed.push("<thinking>36-7</thin");
    closed.push("king>29 apples");
    closed.flush();
    expect(closed.unclosed).toBe(false);
  });
});
