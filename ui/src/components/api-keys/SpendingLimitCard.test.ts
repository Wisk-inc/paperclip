import { describe, expect, it } from "vitest";
import { parseDollars } from "./SpendingLimitCard";

describe("parseDollars", () => {
  it("reads what people type as cents", () => {
    expect(parseDollars("20")).toBe(2000);
    expect(parseDollars("$12.5")).toBe(1250);
    expect(parseDollars(" 1,000.99 ")).toBe(100099);
    expect(parseDollars("0.01")).toBe(1);
  });

  it("refuses anything else", () => {
    expect(parseDollars("")).toBeNull();
    expect(parseDollars("ten")).toBeNull();
    expect(parseDollars("1.234")).toBeNull();
    expect(parseDollars("-5")).toBeNull();
  });
});
