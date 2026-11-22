import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NARROW_SCREEN_QUERY } from "@/hooks/useNarrowScreen";

const stylesheet = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

const PANEL = '[data-slot="studio-editor"] .cm-editor .cm-panel.cm-search';

/** The Find panel's rules: from their comment to the end of their media block. */
function findPanelRules(): string {
  const start = stylesheet.indexOf("/* Find and replace in the code editor");
  expect(start, "Missing the Find panel rules").toBeGreaterThan(0);
  const end = stylesheet.indexOf("\n}\n", start);
  return stylesheet.slice(start, end);
}

function block(rules: string, selector: string): string {
  const start = rules.indexOf(`  ${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);
  return rules.slice(rules.indexOf("{", start) + 1, rules.indexOf("\n  }", start));
}

describe("the code editor's Find panel on one-pane screens", () => {
  const rules = findPanelRules();

  it("applies on the screens where App Studio shows one pane at a time", () => {
    expect(rules).toContain(`@media ${NARROW_SCREEN_QUERY} {`);
  });

  it("is not in a cascade layer, or the editor's own unlayered rules would win", () => {
    // Every block opened before these rules is closed again, so they sit at the top level.
    const before = stylesheet.slice(0, stylesheet.indexOf("/* Find and replace in the code editor")).replace(/\/\*[\s\S]*?\*\//g, "");
    const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);
  });

  it("lays the panel out in two rows, the second one scrolling sideways", () => {
    const panel = block(rules, PANEL);
    expect(panel).toContain("display: grid;");
    expect(panel).toContain("overflow-x: auto;");
    expect(panel).toContain("container-type: inline-size;");
    // The line break between find and replace, and "all", are gone.
    const hidden = rules.slice(rules.indexOf(`${PANEL} br,`), rules.indexOf("display: none;"));
    expect(hidden).toContain(`${PANEL} br,`);
    expect(hidden).toContain(`${PANEL} button[name="select"]`);
    // First row: the two fields and the close button, which stay put while the second row scrolls.
    const first = block(rules, `${PANEL} :is(input[name="search"], input[name="replace"], button[name="close"])`);
    expect(first).toContain("grid-row: 1;");
    expect(first).toContain("position: sticky;");
    const fields = block(rules, `${PANEL} :is(input[name="search"], input[name="replace"])`);
    expect(fields).toContain("width: var(--studio-find-field);");
    expect(fields).toContain("min-width: 0;");
    // Second row: the buttons, then the options, each on one line.
    const second = block(rules, `${PANEL} :is(.cm-button, label)`);
    expect(second).toContain("grid-row: 2;");
    expect(second).toContain("white-space: nowrap;");
    expect(block(rules, `${PANEL} label`)).toContain("order: 1;");
  });

  it("gives the close button a 44 px wide target", () => {
    const close = block(rules, `${PANEL} button[name="close"]`);
    expect(close).toContain("width: var(--sz-44px);");
    expect(close).toContain("left: calc(100cqi - var(--sz-44px));");
  });

  it("takes every size from a token", () => {
    // After the media query itself, with the token names taken out (--sz-44px is a name).
    const declarations = rules.slice(rules.indexOf("{", rules.indexOf("@media"))).replace(/--[a-z0-9-]+/g, "");
    expect(declarations).not.toMatch(/\d(px|rem|em)\b/);
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
