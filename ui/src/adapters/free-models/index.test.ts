import { describe, expect, it } from "vitest";
import { parseFreeModelsStdoutLine } from "./index";

describe("free models transcript", () => {
  it("shows reasoning lines as thinking and everything else as output", () => {
    expect(parseFreeModelsStdoutLine('{"type":"thinking","text":"36 - 7 = 29"}', "t")).toEqual([{ kind: "thinking", ts: "t", text: "36 - 7 = 29" }]);
    expect(parseFreeModelsStdoutLine("Asking deepseek/deepseek-v4.1-flash:free", "t")).toEqual([{ kind: "stdout", ts: "t", text: "Asking deepseek/deepseek-v4.1-flash:free" }]);
    expect(parseFreeModelsStdoutLine('{"type":"thinking", broken', "t")).toEqual([{ kind: "stdout", ts: "t", text: '{"type":"thinking", broken' }]);
  });
});
