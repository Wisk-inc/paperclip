import { describe, expect, it } from "vitest";
import { buildUiStringIndex, fillTemplate, loadUiStringIndex, normalizeUiText, pieceBoundaries } from "./ui-string-index";

const index = buildUiStringIndex([
  "Sign out",
  "  Search   languages ",
  "Delete {0} files?",
  "Follows this device: {0}",
  "On {0}",
  "{0} of {1} done",
  "Status: {0}",
]);

describe("buildUiStringIndex", () => {
  it("knows the board's exact strings, with spacing normalized", () => {
    expect(index.match("Sign out", false)).toEqual({ source: "Sign out", values: [] });
    expect(index.match("  Search\n languages", false)).toEqual({ source: "Search languages", values: [] });
    expect(index.has("Search languages")).toBe(true);
    expect(index.size).toBe(7);
  });

  it("leaves a person's own words alone", () => {
    expect(index.match("Sign out of the meeting early", false)).toBeNull();
    expect(index.match("Buy milk", false)).toBeNull();
    expect(index.match("", false)).toBeNull();
  });

  it("matches templates and returns the values in placeholder order", () => {
    expect(index.match("Delete 3 files?", false)).toEqual({ source: "Delete {0} files?", values: ["3"] });
    expect(index.match("Follows this device: Español (México)", false)).toEqual({
      source: "Follows this device: {0}",
      values: ["Español (México)"],
    });
    expect(index.match("4 of 9 done", true)).toEqual({ source: "{0} of {1} done", values: ["4", "9"] });
  });

  it("trusts a template with few fixed letters only when the text was pieced together on the page", () => {
    // "On {0}" has two fixed letters: a sentence a person wrote must not match it.
    expect(index.match("On Monday we ship", false)).toBeNull();
    expect(index.match("On Monday", true)).toEqual({ source: "On {0}", values: ["Monday"] });
  });

  it("prefers the template with the most fixed words", () => {
    expect(index.match("Status: Done", true)).toEqual({ source: "Status: {0}", values: ["Done"] });
  });

  it("matches text written in parts only where the parts meet", () => {
    const board = buildUiStringIndex([
      "{0} changed {1}",
      "Backend files changed since this server booted.",
      "Delete {0} files?",
      "{0} of {1} done",
    ]);
    // Two parts that are each the board's own text: no template is read across them,
    // so each part is translated on its own.
    const parts = ["Backend files changed since this server booted.", " Updated 5m ago."];
    expect(board.match(parts.join(""), true, parts)).toBeNull();
    // A value in a part of its own and the fixed words in theirs: the template matches.
    expect(board.match("Delete 3 files?", true, ["Delete ", "3", " files?"])).toEqual({ source: "Delete {0} files?", values: ["3"] });
    expect(board.match("4 of 9 done", true, ["4", " of ", "9", " done"])).toEqual({ source: "{0} of {1} done", values: ["4", "9"] });
    // A space on either side of where two parts meet is fine.
    expect(board.match("Delete 3 files?", true, ["Delete", " 3", " files?"])?.source).toBe("Delete {0} files?");
  });
});

describe("pieceBoundaries", () => {
  it("finds where the parts meet in the text as it is matched (spaces collapsed, ends trimmed)", () => {
    expect([...pieceBoundaries(["Delete ", "3", " files?"])].sort((a, b) => a - b)).toEqual([0, 7, 8, 15]);
    expect([...pieceBoundaries(["  Status:  ", "Done "])].sort((a, b) => a - b)).toEqual([0, 8, 12]);
  });
});

describe("fillTemplate", () => {
  it("puts values back in by number, whatever order the translation uses", () => {
    expect(fillTemplate("{1} sur {0} terminées", ["4", "9"])).toBe("9 sur 4 terminées");
    expect(fillTemplate("¿Eliminar {0} archivos?", ["3"])).toBe("¿Eliminar 3 archivos?");
    expect(fillTemplate("Sin {5}", [])).toBe("Sin ");
  });
});

describe("normalizeUiText", () => {
  it("collapses whitespace the way the extractor stored the strings", () => {
    expect(normalizeUiText("  a \n\t b  ")).toBe("a b");
  });
});

describe("loadUiStringIndex", () => {
  it("loads the generated list of the board's strings", async () => {
    const loaded = await loadUiStringIndex();
    expect(loaded.size).toBeGreaterThan(5000);
    expect(loaded.has("Language")).toBe(true);
    expect(loaded.has("Search languages")).toBe(true);
    expect(loaded.match("Follows this device: Deutsch", false)?.source).toBe("Follows this device: {0}");
  });
});
