import { describe, expect, it } from "vitest";
import { AUTOMA_RELEASES, formatReleaseDate } from "./release-history";

describe("release history", () => {
  it("lists every release once, newest first, with a real date", () => {
    const versions = AUTOMA_RELEASES.map((release) => release.version);
    expect(new Set(versions).size).toBe(versions.length);
    const dates = AUTOMA_RELEASES.map((release) => release.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const date of dates) expect(formatReleaseDate(date)).not.toBeNull();
    expect(AUTOMA_RELEASES.at(-1)!.version).toBe("1.0.0");
  });

  it("formats dates and times, and ignores what is not one", () => {
    expect(formatReleaseDate("2026-09-27")).toMatch(/2026/);
    expect(formatReleaseDate("2026-10-24T14:05:00.000Z", true)).toMatch(/2026/);
    expect(formatReleaseDate("soon")).toBeNull();
    expect(formatReleaseDate(undefined)).toBeNull();
  });
});
