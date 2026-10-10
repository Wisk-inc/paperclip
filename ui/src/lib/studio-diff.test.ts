import { describe, expect, it } from "vitest";
import { diffLines, diffStats, foldUnchanged } from "./studio-diff";

describe("diffLines", () => {
  it("marks a changed line as removed then added", () => {
    const lines = diffLines('print("hello")\n', 'print("Hello world")\n');
    expect(lines).toEqual([
      { type: "del", text: 'print("hello")', oldNo: 1 },
      { type: "add", text: 'print("Hello world")', newNo: 1 },
    ]);
  });

  it("keeps unchanged lines and numbers both sides", () => {
    const lines = diffLines("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
    expect(lines.map((line) => line.type)).toEqual(["same", "del", "add", "same", "same", "add"]);
    const last = lines.at(-1)!;
    expect(last).toEqual({ type: "add", text: "e", newNo: 5 });
    expect(lines[3]).toEqual({ type: "same", text: "c", oldNo: 3, newNo: 3 });
  });

  it("treats a new file as all additions and a deleted file as all removals", () => {
    expect(diffStats(diffLines(null, "x\ny\n"))).toEqual({ added: 2, removed: 0 });
    expect(diffStats(diffLines("x\ny\n", null))).toEqual({ added: 0, removed: 2 });
  });

  it("finds an inserted line in the middle without touching the rest", () => {
    const lines = diffLines("one\ntwo\nthree\n", "one\ntwo\nnew\nthree\n");
    expect(diffStats(lines)).toEqual({ added: 1, removed: 0 });
    expect(lines.find((line) => line.type === "add")).toEqual({ type: "add", text: "new", newNo: 3 });
  });

  it("folds long unchanged runs", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 15", "line fifteen");
    const rows = foldUnchanged(diffLines(before, after), 2);
    expect(rows[0]).toEqual({ type: "skip", count: 13 });
    expect(rows.filter((row) => row.type === "skip")).toHaveLength(2);
    expect(rows.filter((row) => row.type === "del" || row.type === "add")).toHaveLength(2);
  });
});
