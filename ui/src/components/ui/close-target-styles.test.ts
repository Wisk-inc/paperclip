import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

describe("the X on a sheet and on a dialog, in the stylesheet", () => {
  // The rule for phones, from its comment to the end of its media block.
  const start = stylesheet.indexOf("/* Phones: every control a thumb lands on is at least 44px");
  const rules = stylesheet.slice(start, stylesheet.indexOf("\n}\n", start));

  const selectorsOf = (declaration: string) => {
    const end = rules.indexOf(declaration);
    expect(end, `Missing ${declaration}`).toBeGreaterThan(0);
    return rules.slice(rules.lastIndexOf("}", end) + 1, end);
  };

  it("belongs to the rule for touch screens", () => {
    expect(start).toBeGreaterThan(0);
    expect(rules).toContain("@media (hover: none) and (pointer: coarse) {");
  });

  it.each(['[data-slot="sheet-close"]', '[data-slot="dialog-close"]'])("is at least 44 px each way, centred, and shows a press: %s", (slot) => {
    const sized = selectorsOf("min-width: var(--sz-44px);");
    expect(sized).toContain(slot);
    expect(sized).toContain("min-height: var(--sz-44px);");
    expect(selectorsOf("justify-content: center;")).toContain(slot);
    expect(selectorsOf("justify-content: center;")).toContain("align-items: center;");
    expect(selectorsOf("background-color: var(--accent);")).toContain(`${slot}:active`);
  });
});
