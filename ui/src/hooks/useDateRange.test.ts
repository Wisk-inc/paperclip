import { describe, expect, it } from "vitest";
import { computeRange, utcMonthStart } from "./useDateRange";

describe("this month, as budgets count it", () => {
  it("starts at the UTC month boundary, whatever the local time zone", () => {
    // 21:30 on 31 October in Jamaica (UTC-5) is already 1 November in UTC.
    const now = new Date("2026-11-01T02:30:00.000Z");
    expect(utcMonthStart(now).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(computeRange("mtd", now)).toEqual({ from: "2026-11-01T00:00:00.000Z", to: "2026-11-01T02:30:00.000Z" });
  });

  it("keeps the other presets as they were", () => {
    const now = new Date("2026-11-15T12:00:00.000Z");
    expect(computeRange("all", now)).toEqual({ from: "", to: "" });
    expect(computeRange("7d", now).to).toBe("2026-11-15T12:00:00.000Z");
  });
});
