import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatReleaseDate } from "@/lib/release-history";
import { formatLocale, formatsInEnglish, setFormatLocale, subscribeFormatLocale } from "./format-locale";

/** Arabic-Indic, Persian (Extended Arabic-Indic), Devanagari and Bengali digits. */
const OTHER_DIGITS = /[٠-٩۰-۹०-९০-৯]/;
const NOV_18 = new Date(Date.UTC(2026, 10, 18, 9, 30));

afterEach(() => setFormatLocale(null));

describe("the board's format locale", () => {
  it("writes dates and numbers with Western digits in every language, like the numbers the board writes as they are", () => {
    for (const locale of ["ar-EG", "fa-IR", "bn-BD", "mr-IN", "ur-IN"]) {
      setFormatLocale(locale);
      const number = (1234567.5).toLocaleString(formatLocale());
      const date = NOV_18.toLocaleString(formatLocale(), { timeZone: "UTC" });
      expect(number, locale).toMatch(/\d/);
      expect(number, locale).not.toMatch(OTHER_DIGITS);
      expect(date, locale).not.toMatch(OTHER_DIGITS);
    }
  });

  it("keeps the language's own words, separators and calendar, and a locale with Western digits as it is", () => {
    setFormatLocale("ar-EG");
    expect(NOV_18.toLocaleDateString(formatLocale(), { month: "long", timeZone: "UTC" })).toBe("نوفمبر");
    expect(formatsInEnglish()).toBe(false);
    setFormatLocale("bn-BD");
    expect((1234567.5).toLocaleString(formatLocale())).toBe("12,34,567.5");
    setFormatLocale("fa-IR");
    expect(NOV_18.toLocaleDateString(formatLocale(), { timeZone: "UTC" })).toBe("1405/8/27");
    setFormatLocale("es-MX");
    expect(formatLocale()).toBe("es-MX");
    setFormatLocale("de-DE");
    expect((1234.5).toLocaleString(formatLocale())).toBe("1.234,5");
    setFormatLocale(null);
    expect(formatLocale()).toBe("en-US");
    expect(formatsInEnglish()).toBe(true);
  });

  it("formats the board's dates in the language chosen in Automa, not the phone's", () => {
    setFormatLocale("es-MX");
    expect(formatReleaseDate("2026-11-18")).toBe("18 nov 2026");
    setFormatLocale("de-DE");
    expect(formatReleaseDate("2026-11-18")).toBe("18. Nov. 2026");
  });

  it("tells whoever listens when the format changes, and only then", () => {
    setFormatLocale("en-US");
    const heard: string[] = [];
    const stop = subscribeFormatLocale(() => heard.push(formatLocale()));
    setFormatLocale("es-MX");
    // The same locale again, as the provider does on every render: nothing to draw.
    setFormatLocale(" es-MX ");
    setFormatLocale("ar-EG");
    stop();
    setFormatLocale("de-DE");
    expect(heard).toEqual(["es-MX", "ar-EG-u-nu-latn"]);
  });

  it("reaches every memoized component that can show a date or number when the language changes", () => {
    // A memoized component keeps what it drew while its props stay the same, so
    // a language switch reaches it only through useFormatLocale (the board's
    // root redraws everything else).
    const root = fileURLToPath(new URL("..", import.meta.url));
    const neverShowsDates = new Set([
      "components/JsonSchemaForm.tsx", // form fields
      "components/MarkdownBody.tsx", // the person's and agents' own text
      "components/mascot/Mascot.tsx", // the mascot's drawing
      "components/NewIssueDialog.tsx", // the title and description editors
    ]);
    const missing: string[] = [];
    const visit = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) visit(path);
        else if (name.endsWith(".tsx") && !/\.(test|stories)\.tsx$/.test(name)) {
          const relative = path.slice(root.length).replace(/\\/g, "/");
          const source = readFileSync(path, "utf8");
          const memoized = (source.match(/\bmemo\(/g) ?? []).length;
          if (!memoized || neverShowsDates.has(relative)) continue;
          const subscribed = (source.match(/useFormatLocale\(\);/g) ?? []).length;
          if (subscribed < memoized) missing.push(`${relative}: ${memoized} memoized, ${subscribed} redrawn`);
        }
      }
    };
    visit(root);
    expect(missing).toEqual([]);
  });

  it("is what every date and number on the board is formatted with: none follows the phone's own locale", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const phoneLocale = /\.toLocale(?:String|DateString|TimeString)\((?:\)|undefined|\[\])|\bIntl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat)\((?:undefined|\[\])/;
    const offenders: string[] = [];
    const visit = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) visit(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
          readFileSync(path, "utf8").split("\n").forEach((line, index) => {
            if (phoneLocale.test(line)) offenders.push(`${path.slice(root.length)}:${index + 1}: ${line.trim()}`);
          });
        }
      }
    };
    visit(root);
    expect(offenders).toEqual([]);
  });
});
