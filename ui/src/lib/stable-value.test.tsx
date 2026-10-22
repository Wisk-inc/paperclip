// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { structurallyEqual, useLatestCallback, useStableEntries } from "./stable-value";

describe("structurallyEqual", () => {
  it("compares plain data by content", () => {
    expect(structurallyEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
    expect(structurallyEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false);
    expect(structurallyEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(structurallyEqual(new Date(5), new Date(5))).toBe(true);
    expect(structurallyEqual([1], { 0: 1 })).toBe(false);
  });

  it("compares functions and class instances by identity", () => {
    const fn = () => 1;
    expect(structurallyEqual({ fn }, { fn })).toBe(true);
    expect(structurallyEqual({ fn }, { fn: () => 1 })).toBe(false);
    expect(structurallyEqual(new Map(), new Map())).toBe(false);
  });
});

describe("useStableEntries and useLatestCallback", () => {
  it("keeps unchanged entries and one callback identity", async () => {
    const seen: Array<{ entries: Array<{ id: string; text: string }>; callback: (() => string) | undefined }> = [];
    function Harness({ entries, callback }: { entries: Array<{ id: string; text: string }>; callback?: () => string }) {
      seen.push({ entries: useStableEntries(entries, (entry) => entry.id), callback: useLatestCallback(callback) });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness entries={[{ id: "a", text: "one" }, { id: "b", text: "two" }]} callback={() => "first"} />));
    await act(async () => root.render(<Harness entries={[{ id: "a", text: "one" }, { id: "b", text: "two!" }]} callback={() => "second"} />));
    expect(seen[1]!.callback!()).toBe("second");
    await act(async () => root.render(<Harness entries={[{ id: "a", text: "one" }, { id: "b", text: "two!" }]} />));

    const [first, second, third] = seen;
    expect(second!.entries[0]).toBe(first!.entries[0]);
    expect(second!.entries[1]).not.toBe(first!.entries[1]);
    expect(third!.entries).toBe(second!.entries);
    expect(second!.callback).toBe(first!.callback);
    expect(third!.callback).toBeUndefined();
    expect(second!.callback!()).toBeUndefined();
    await act(async () => root.unmount());
  });
});
