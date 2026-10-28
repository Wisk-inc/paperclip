import { readFileSync } from "node:fs";
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
    for (let index = 1; index < versions.length; index += 1) {
      const newer = versions[index - 1]!.split(".").map(Number);
      const older = versions[index]!.split(".").map(Number);
      const step = newer.map((part, at) => part - older[at]!).find((difference) => difference !== 0);
      expect(step, `${versions[index - 1]} is listed above ${versions[index]}`).toBeGreaterThan(0);
    }
  });

  it("starts with the version the Android app is built as", () => {
    const gradle = readFileSync(new URL("../../../mobile/android/gradle.properties", import.meta.url), "utf8");
    expect(AUTOMA_RELEASES[0]!.version).toBe(/^automa\.versionName=(.+)$/m.exec(gradle)?.[1]?.trim());
  });

  it("formats dates and times, and ignores what is not one", () => {
    expect(formatReleaseDate("2026-09-27")).toMatch(/2026/);
    expect(formatReleaseDate("2026-10-24T14:05:00.000Z", true)).toMatch(/2026/);
    expect(formatReleaseDate("soon")).toBeNull();
    expect(formatReleaseDate(undefined)).toBeNull();
  });

  it("shows a release on the day it came out in every time zone", () => {
    const zone = process.env.TZ;
    try {
      for (const tz of ["Pacific/Kiritimati", "Pacific/Auckland", "America/Jamaica", "Pacific/Pago_Pago"]) {
        process.env.TZ = tz;
        expect(formatReleaseDate("2026-10-28")).toMatch(/\b28\b/);
      }
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
