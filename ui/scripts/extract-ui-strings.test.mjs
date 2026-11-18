import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OUTPUT, extractAll, extractFromSource, render } from "./extract-ui-strings.mjs";

const strings = (source, filename = "Example.tsx") => [...extractFromSource(source, filename)].sort();

test("JSX text, with values as numbered placeholders and the fixed pieces on their own", () => {
  const found = strings(`
    export function A({ count, name }) {
      return (
        <div>
          <h1>Sign out</h1>
          <p>Delete {count} files?</p>
          <p>Hello {"there"}, friend</p>
          <span>{count} of {name} done</span>
        </div>
      );
    }
  `);
  assert.ok(found.includes("Sign out"));
  assert.ok(found.includes("Delete {0} files?"));
  assert.ok(found.includes("Delete"));
  assert.ok(found.includes("files?"));
  assert.ok(found.includes("Hello there, friend"));
  assert.ok(found.includes("{0} of {1} done"));
});

test("text attributes, rendered branches and template literals", () => {
  const found = strings(`
    export function B({ busy, who }) {
      return (
        <>
          <input placeholder="Search languages" aria-label={busy ? "Saving" : "Save"} />
          <img alt="Your photo" src="/x.png" />
          <span>{busy ? "Working…" : \`Follows this device: \${who}\`}</span>
        </>
      );
    }
  `);
  for (const text of ["Search languages", "Saving", "Save", "Your photo", "Working…", "Follows this device: {0}"]) {
    assert.ok(found.includes(text), text);
  }
});

test("labels in objects, errors and toasts; sentences elsewhere", () => {
  const found = strings(`
    const ITEMS = [{ label: "New task", value: "new_task" }];
    function f() {
      if (!ok) throw new Error("Pick an organization first.");
      pushToast({ title: "Name saved" });
      const note = "Only Automa’s own words are sent.";
      const id = "agent_key";
      return note + id;
    }
  `, "example.ts");
  for (const text of ["New task", "Pick an organization first.", "Name saved", "Only Automa’s own words are sent."]) {
    assert.ok(found.includes(text), text);
  }
  assert.ok(!found.includes("new_task"));
  assert.ok(!found.includes("agent_key"));
});

test("never code: class names, paths, URLs, ids, test ids, logs, i18n keys, SVG paths", () => {
  const found = strings(`
    export function C({ x }) {
      console.log("Loaded the board");
      const label = t("app.noCompanies.title");
      return (
        <svg className="flex items-center gap-2" data-testid="Some test id">
          <path d={\`M\${x},\${x} l-10,-5 l0,10 z\`} />
          <a href="https://example.com/docs">/api/companies</a>
        </svg>
      );
    }
  `);
  for (const text of ["flex items-center gap-2", "Some test id", "Loaded the board", "app.noCompanies.title", "M{0},{1} l-10,-5 l0,10 z", "https://example.com/docs", "/api/companies"]) {
    assert.ok(!found.includes(text), text);
  }
});

test("a sentence with a semicolon is a sentence; code with one is not", () => {
  const found = strings(`
    export const A = () => (
      <Row hint="Checks this phone, the database and Automa; fixes what it can" style="color:red;" />
    );
    const css = "display:none;";
  `);
  assert.ok(found.includes("Checks this phone, the database and Automa; fixes what it can"));
  assert.ok(!found.includes("color:red;"));
  assert.ok(!found.includes("display:none;"));
});

test("HTML entities in JSX text and attribute strings are decoded the way the page shows them", () => {
  const found = strings(`
    export const A = ({ name }) => (
      <p title="OAuth &amp; Permissions">
        Couldn&apos;t load {name}&apos;s runs &rarr; try &ldquo;Reload&rdquo; &#8212; or &#x2192; later
      </p>
    );
    const braces = <b>{"Tom &amp; Jerry"}</b>;
  `);
  assert.ok(found.includes("OAuth & Permissions"));
  assert.ok(found.includes("Couldn't load {0}'s runs → try “Reload” — or → later"));
  assert.ok(!found.some((text) => text.includes("&apos;") || text.includes("&rarr;")));
  // A JS string in braces is shown as written.
  assert.ok(found.includes("Tom &amp; Jerry"));
});

test("labels in option lists written as objects", () => {
  const found = strings(`const MODES = [{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }];`, "modes.ts");
  assert.ok(found.includes("Light"));
  assert.ok(found.includes("Dark"));
  assert.ok(!found.includes("light"));
});

test("time units and short labels are kept (they are words people read)", () => {
  const found = strings(`export const A = ({ h, m }) => <span>{h}h {m}m</span>;`);
  assert.ok(found.includes("{0}h {1}m"));
});

test("the generated list is up to date with the board's code", () => {
  const current = readFileSync(OUTPUT, "utf8");
  assert.equal(current, render(extractAll()), "run pnpm i18n:extract");
});
