// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FSI, LiveTranslator, MAX_BOARD_TEXT, PDI } from "./live-translator";
import { buildUiStringIndex } from "./ui-string-index";

const SPANISH: Record<string, string> = {
  "Sign out": "Cerrar sesión",
  "Search languages": "Buscar idiomas",
  "Close": "Cerrar",
  "Delete {0} files?": "¿Eliminar {0} archivos?",
  "{0} of {1} done": "{0} de {1} terminadas",
  "Status: {0}": "Estado: {0}",
  "Done": "Hecho",
  "Your photo": "Tu foto",
};
const index = buildUiStringIndex([...Object.keys(SPANISH), "Settings", "New task"]);

let root: HTMLDivElement;
let translator: LiveTranslator | null = null;
let translations: Record<string, string>;
let missing: string[];

/** Lets the translator's MutationObserver and its microtask run. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function start() {
  translator = new LiveTranslator({
    root,
    index,
    lookup: (source) => translations[source],
    onMissing: (sources) => missing.push(...sources),
  });
  translator.start();
  return translator;
}

beforeEach(() => {
  translations = { ...SPANISH };
  missing = [];
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  translator?.stop();
  translator = null;
  root.remove();
});

describe("LiveTranslator", () => {
  it("translates the board's text and keeps its spacing", () => {
    root.innerHTML = `<button> Sign out </button><p>Buy milk</p>`;
    start();
    expect(root.querySelector("button")!.textContent).toBe(" Cerrar sesión ");
    // A person's own words are not the board's: untouched.
    expect(root.querySelector("p")!.textContent).toBe("Buy milk");
  });

  it("translates the attributes people read or hear", () => {
    root.innerHTML = `<input placeholder="Search languages"><button aria-label="Close" title="Close">x</button><img alt="Your photo">`;
    start();
    expect(root.querySelector("input")!.getAttribute("placeholder")).toBe("Buscar idiomas");
    expect(root.querySelector("button")!.getAttribute("aria-label")).toBe("Cerrar");
    expect(root.querySelector("button")!.getAttribute("title")).toBe("Cerrar");
    expect(root.querySelector("img")!.getAttribute("alt")).toBe("Tu foto");
  });

  it("translates a sentence React wrote in pieces, values kept", () => {
    const p = document.createElement("p");
    // What <p>Delete {count} files?</p> renders: three text nodes.
    p.append("Delete ", "3", " files?");
    root.append(p);
    start();
    expect(p.textContent).toBe("¿Eliminar 3 archivos?");
    const q = document.createElement("p");
    q.append("4", " of ", "9", " done");
    root.append(q);
    translator!.refresh();
    expect(q.textContent).toBe("4 de 9 terminadas");
  });

  it("does not read a template across two of the board's own texts written side by side", () => {
    const own: Record<string, string> = {
      "{0} changed {1}": "{0} cambió {1}",
      "Backend files changed since this server booted.": "Los archivos del servidor cambiaron desde que arrancó.",
      "Updated {0}.": "Actualizado {0}.",
    };
    const p = document.createElement("p");
    // What <p>{reason}{changedAt ? ` Updated ${changedAt}.` : ""}</p> renders: two text nodes.
    p.append("Backend files changed since this server booted.", " Updated 5m ago.");
    root.append(p);
    translator = new LiveTranslator({ root, index: buildUiStringIndex(Object.keys(own)), lookup: (source) => own[source] });
    translator.start();
    expect(p.textContent).toBe("Los archivos del servidor cambiaron desde que arrancó. Actualizado 5m ago.");
  });

  it("translates a few of the board's sentences written side by side in one run", () => {
    const own: Record<string, string> = {
      agents: "agentes",
      "· led by {0}": "· dirigida por {0}",
      "Sign out": "Cerrar sesión",
    };
    const p = document.createElement("p");
    // What <p>{count} {label}{lead ? <> · led by {lead.name}</> : null}</p> renders.
    p.append("2", " ", "agents", " · led by ", "Nova");
    // A board string next to a person's words: only the board's part is translated.
    const q = document.createElement("p");
    q.append("Sign out", " Buy milk");
    root.append(p, q);
    translator = new LiveTranslator({ root, index: buildUiStringIndex(Object.keys(own)), lookup: (source) => own[source] });
    translator.start();
    expect(p.textContent).toBe("2 agentes · dirigida por Nova");
    expect(q.textContent).toBe("Cerrar sesión Buy milk");
    // Back to English, every piece as it was.
    translator.stop();
    translator = null;
    expect(p.textContent).toBe("2 agents · led by Nova");
    expect(Array.from(p.childNodes).map((node) => node.textContent)).toEqual(["2", " ", "agents", " · led by ", "Nova"]);
  });

  it("translates a value that is itself a board string", () => {
    const p = document.createElement("p");
    p.append("Status: ", "Done");
    root.append(p);
    start();
    expect(p.textContent).toBe("Estado: Hecho");
  });

  it("never touches text marked translate=no, .notranslate, editors, text boxes or code", () => {
    root.innerHTML = [
      `<div translate="no"><span>Sign out</span></div>`,
      `<div class="notranslate">Sign out</div>`,
      `<div contenteditable="true">Sign out</div>`,
      `<textarea>Sign out</textarea>`,
      `<pre>Sign out</pre>`,
      `<code>Sign out</code>`,
      `<button>Sign out</button>`,
    ].join("");
    start();
    const texts = Array.from(root.children).map((child) => child.textContent);
    expect(texts).toEqual(["Sign out", "Sign out", "Sign out", "Sign out", "Sign out", "Sign out", "Cerrar sesión"]);
  });

  it("passes over text longer than any board string", () => {
    const long = `Sign out ${"x".repeat(MAX_BOARD_TEXT)}`;
    root.innerHTML = `<p></p>`;
    root.querySelector("p")!.textContent = long;
    start();
    expect(root.querySelector("p")!.textContent).toBe(long);
    expect(missing).toEqual([]);
  });

  it("translates what appears later and what React changes", async () => {
    start();
    const button = document.createElement("button");
    button.textContent = "Sign out";
    root.append(button);
    await settle();
    expect(button.textContent).toBe("Cerrar sesión");
    // React writes new text into the same node.
    button.firstChild!.nodeValue = "Close";
    await settle();
    expect(button.textContent).toBe("Cerrar");
    // And text that is not the board's stays as React wrote it.
    button.firstChild!.nodeValue = "Ana Pérez";
    await settle();
    expect(button.textContent).toBe("Ana Pérez");
    // An attribute set later.
    button.setAttribute("title", "Close");
    await settle();
    expect(button.getAttribute("title")).toBe("Cerrar");
  });

  it("re-translates a pieced sentence when one of its values changes", async () => {
    const p = document.createElement("p");
    const count = document.createTextNode("3");
    p.append("Delete ", count, " files?");
    root.append(p);
    start();
    expect(p.textContent).toBe("¿Eliminar 3 archivos?");
    count.nodeValue = "5";
    await settle();
    expect(p.textContent).toBe("¿Eliminar 5 archivos?");
  });

  it("reports board strings it has no translation for, and uses them once they arrive", async () => {
    root.innerHTML = `<a>Settings</a><a>New task</a><a>Sign out</a>`;
    start();
    expect(missing.sort()).toEqual(["New task", "Settings"]);
    translations.Settings = "Ajustes";
    translator!.refresh();
    expect(root.querySelector("a")!.textContent).toBe("Ajustes");
  });

  it("puts every original back when stopped (back to English)", () => {
    root.innerHTML = `<button title="Close">Sign out</button><input placeholder="Search languages">`;
    const p = document.createElement("p");
    p.append("Delete ", "3", " files?");
    root.append(p);
    const stopped = start();
    expect(stopped.translatedCount).toBeGreaterThan(0);
    stopped.stop();
    translator = null;
    expect(root.querySelector("button")!.textContent).toBe("Sign out");
    expect(root.querySelector("button")!.getAttribute("title")).toBe("Close");
    expect(root.querySelector("input")!.getAttribute("placeholder")).toBe("Search languages");
    expect(p.textContent).toBe("Delete 3 files?");
    expect(Array.from(p.childNodes).map((node) => node.nodeValue)).toEqual(["Delete ", "3", " files?"]);
  });

  describe("right to left (isolate)", () => {
    const startIsolated = () => {
      translator = new LiveTranslator({
        root,
        index,
        lookup: (source) => translations[source],
        onMissing: (sources) => missing.push(...sources),
        isolate: true,
      });
      translator.start();
      return translator;
    };

    it("keeps a value's own direction inside a translation", () => {
      translations["Delete {0} files?"] = "حذف {0} ملفات؟";
      const p = document.createElement("p");
      p.append("Delete ", "Español (México)", " files?");
      root.append(p);
      startIsolated();
      expect(p.textContent).toBe(`حذف ${FSI}Español (México)${PDI} ملفات؟`);
    });

    it("keeps board text that is still English in its own direction until the translation comes", () => {
      root.innerHTML = `<p> Settings </p><p>Buy milk.</p>`;
      startIsolated();
      const [settings, personal] = Array.from(root.querySelectorAll("p"));
      expect(settings!.textContent).toBe(` ${FSI}Settings${PDI} `);
      // A person's words are never touched, isolated or not.
      expect(personal!.textContent).toBe("Buy milk.");
      expect(missing).toEqual(["Settings"]);
      translations.Settings = "الإعدادات";
      translator!.refresh();
      expect(settings!.textContent).toBe(" الإعدادات ");
    });

    it("puts the plain originals back when stopped", () => {
      root.innerHTML = `<p>Settings</p><button title="Settings">x</button>`;
      const p = document.createElement("p");
      p.append("Delete ", "3", " files?");
      root.append(p);
      const stopped = startIsolated();
      stopped.stop();
      translator = null;
      expect(root.querySelector("p")!.textContent).toBe("Settings");
      expect(root.querySelector("button")!.getAttribute("title")).toBe("Settings");
      expect(Array.from(p.childNodes).map((node) => node.nodeValue)).toEqual(["Delete ", "3", " files?"]);
    });

    it("left to right languages get no isolates", () => {
      root.innerHTML = `<p>Settings</p>`;
      start();
      expect(root.querySelector("p")!.textContent).toBe("Settings");
    });
  });

  it("does not loop on its own writes", async () => {
    const lookup = vi.fn((source: string) => translations[source]);
    root.innerHTML = `<button>Sign out</button>`;
    translator = new LiveTranslator({ root, index, lookup });
    translator.start();
    const calls = lookup.mock.calls.length;
    await settle();
    await settle();
    expect(lookup.mock.calls.length).toBe(calls);
  });
});
