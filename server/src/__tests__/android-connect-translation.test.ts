// @vitest-environment jsdom
/**
 * The Android app's connect screen in the person's language: the real page,
 * its translator (i18n.js) with the dictionaries the app ships
 * (assets/connect/i18n, made by mobile/android/scripts/sync-translations.mjs),
 * and connect.js with a stand-in for the app's bridge.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// From this file's own path (in a jsdom test, URL is jsdom's, which Node's fileURLToPath does not take).
const ANDROID = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mobile", "android");
const CONNECT = path.join(ANDROID, "app", "src", "main", "assets", "connect");
const html = fs.readFileSync(path.join(CONNECT, "index.html"), "utf8");
const translator = fs.readFileSync(path.join(CONNECT, "i18n.js"), "utf8");
const script = fs.readFileSync(path.join(CONNECT, "connect.js"), "utf8");
const LISTED: string[] = JSON.parse(fs.readFileSync(path.join(ANDROID, "i18n", "connect-strings.json"), "utf8"));
const dictionary = (language: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(CONNECT, "i18n", `${language}.json`), "utf8"));
const FSI = "⁨";
const PDI = "⁩";

type Reply = Record<string, unknown>;
const SILENT: Reply = { ok: false, silent: true, error: "Nothing answers on this phone at 127.0.0.1:3100." };
const starting = (extra: Reply = {}): Reply => ({
  ok: false,
  starting: true,
  error: "Automa on this phone is still starting. Try again in a moment.",
  ...extra,
});

/** {0}, {1}… of a listed sentence's translation, filled. */
function fill(translation: string, values: Record<number, string>): string {
  return translation.replace(/\{(\d+)\}/g, (whole, index: string) => values[Number(index)] ?? whole);
}
/** A translation as a pattern: its values may be anything. */
function shape(translation: string): RegExp {
  return new RegExp(`^${translation.split(/\{\d+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+?")}$`);
}

/**
 * Opens the connect screen in `language` (the choice the app keeps, as the
 * board's language switch sets it), with `replies` to its connect tries.
 */
async function open(language: string, replies: Reply[] | ((n: number) => Reply) = [SILENT], state: Reply = {}) {
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
  window.history.replaceState(null, "", `/assets/connect/index.html${state.wait === false ? "" : "?wait=1"}`);
  let connects = 0;
  const next = (n: number): Reply => (typeof replies === "function" ? replies(n) : replies[Math.min(n, replies.length - 1)]!);
  const answer = (callId: string, reply: Reply) =>
    setTimeout(() => (window as any).__automaNative.resolve(callId, JSON.stringify(reply)), 10);
  (window as any).__automaKey = "page-key";
  (window as any).AutomaNative = {
    getLanguage: (key: string) => (key === "page-key" ? language : "auto"),
    connect: (_key: string, _value: string, callId: string) => {
      answer(callId, next(connects));
      connects += 1;
    },
    getConnectState: () => JSON.stringify({
      serverUrl: "http://127.0.0.1:3100",
      recent: ["http://127.0.0.1:3100"],
      appVersion: "1.9.14",
      buildTime: "",
      phoneAddress: null,
      requested: null,
      waitFor: state.wait === false ? null : "http://127.0.0.1:3100",
      startedByRequest: true,
    }),
    isTermuxInstalled: () => true,
    termuxRunPermissionGranted: () => true,
    startAutomaInTermux: (_key: string, callId: string) => answer(callId, { ok: true }),
    hasServerBundle: () => true,
    getAuthState: () => JSON.stringify({ enabled: false, user: null }),
    haptic: () => undefined,
  };
  vi.stubGlobal("fetch", async (url: string) => {
    const name = String(url).replace(/^.*i18n\//, "").replace(/\.json$/, "");
    return { ok: true, json: async () => dictionary(name) };
  });
  new Function(translator)();
  new Function(script)();
  // The dictionary arrives (a promise), then the page's first try.
  await vi.advanceTimersByTimeAsync(20);
  const el = (id: string) => document.getElementById(id)!;
  return {
    text: (id: string) => el(id).textContent ?? "",
    hidden: (id: string) => el(id).hidden,
    el,
  };
}

/** Lets the page take `count` more tries (each: the reply, then the 3 s wait). */
async function tries(count: number) {
  for (let i = 0; i < count; i += 1) await vi.advanceTimersByTimeAsync(3_010);
}

/** Names that read the same in every language. */
const SAME_EVERYWHERE = /^(?:Automa|Discord|Termux|HTTPS|×)$/;

describe("the connect screen's words", () => {
  it("are all on its list: every step, shown now or later, and every label", () => {
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
    const listed = new Set(LISTED);
    const patterns = LISTED.filter((text) => /\{\d+\}/.test(text)).map(shape);
    const covered = (text: string) => listed.has(text) || patterns.some((pattern) => pattern.test(text));
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    const skip = 'code, pre, kbd, script, style, textarea, [translate="no"]';
    const missing: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll("*"))) {
      if (element.closest(skip)) continue;
      const children = Array.from(element.childNodes);
      // A sentence with words in bold or a command inside is listed whole ("Tap {0}.").
      let index = 0;
      const sentence = normalize(children.map((node) => (node.nodeType === 3 ? node.nodeValue : node.nodeType === 1 ? `{${index++}}` : "")).join(""));
      for (const node of children) {
        if (node.nodeType !== 3) continue;
        const text = normalize(node.nodeValue ?? "");
        if (!/\p{L}{2,}/u.test(text) || SAME_EVERYWHERE.test(text)) continue;
        if (!covered(text) && !(index > 0 && listed.has(sentence))) missing.push(index > 0 ? sentence : text);
      }
      for (const name of ["placeholder", "title", "aria-label", "alt"]) {
        const value = normalize(element.getAttribute(name) ?? "");
        if (/\p{L}{2,}/u.test(value) && !SAME_EVERYWHERE.test(value) && !covered(value)) missing.push(`${name}=${value}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});

describe("the connect screen in another language", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.scrollIntoView = () => undefined;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows its setup steps whole, in the language's own word order, Termux's own labels and commands as they are", async () => {
    const es = dictionary("es");
    const page = await open("es");
    const steps = Array.from(page.el("wait-fix").querySelectorAll("ol li"));
    // "In Termux, long-press the screen, tap <b>Paste</b>, then press Enter.": Termux's menu says Paste.
    expect(steps[1]!.textContent).toBe(fill(es["In Termux, long-press the screen, tap {0}, then press Enter."]!, { 0: "Paste" }));
    expect(steps[1]!.querySelector('b[translate="no"]')!.textContent).toBe("Paste");
    // "Tap <b>Copy fix and open Termux</b>.": the button's own words, translated as the button is.
    expect(steps[0]!.textContent).toBe(fill(es["Tap {0}."]!, { 0: es["Copy fix and open Termux"]! }));
    expect(page.text("wait-fix-copy")).toBe(es["Copy fix and open Termux"]);
    // A command stays as written, inside the translated sentence.
    const fix = page.el("wait-fix").querySelector("span")!;
    expect(fix.querySelector("code")!.textContent).toBe("allow-external-apps");
    expect(fix.textContent).toBe(fill(es["Termux only lets other apps start Automa once {0} is on."]!, { 0: "allow-external-apps" }));
    // Labels people hear or type into.
    expect(page.el("app-key").getAttribute("placeholder")).toBe(es["App key from automa link"]);
    expect(page.text("version")).toBe(fill(es["Automa for Android {0}"]!, { 0: "1.9.14" }));
  });

  it("says which step a starting Automa is on, and how long, in the language", async () => {
    const es = dictionary("es");
    const page = await open("es", [starting({ step: "Checking assigned tasks", seconds: 40, stepSeconds: 3, stepNumber: 13, stepTotal: 23 })]);
    await tries(1);
    expect(page.text("wait-status")).toBe(fill(es["Automa is starting up: {0}…"]!, { 0: es["checking assigned tasks"]! }));
    const time = page.text("wait-time");
    expect(time).toMatch(shape(es["Waiting {0} · step {1} of {2}"]!));
    expect(time).toContain("13");
    expect(time).not.toContain("Waiting");
    // Durations in the language's own units (Intl), not "min"/"s" pasted in.
    expect(time).toContain(new Intl.NumberFormat("es", { style: "unit", unit: "second", unitDisplay: "short" }).format(3).replace(/\d+/, "").trim());
  });

  it("clears the 'on this step for 5 min' help once Automa moves on, whatever the language", async () => {
    const page = await open("es", [
      starting({ step: "Starting plugins", seconds: 400, stepSeconds: 301, stepNumber: 5, stepTotal: 23 }),
      starting({ step: "Resuming waiting work", seconds: 404, stepSeconds: 1, stepNumber: 6, stepTotal: 23 }),
    ]);
    expect(page.hidden("wait-help")).toBe(false);
    expect(page.text("wait-help")).not.toContain("Automa has been on this step");
    await tries(1);
    expect(page.hidden("wait-help")).toBe(true);
  });

  it("explains what failed in the language, the address kept as typed, an optional part translated too", async () => {
    const es = dictionary("es");
    const page = await open("es", [{ ok: false, error: "Could not find automa.local. Check the spelling and that this phone is on the same Wi-Fi or tailnet." }], { wait: false });
    (page.el("server") as HTMLInputElement).value = "automa.local";
    page.el("connect").click();
    await vi.advanceTimersByTimeAsync(50);
    expect(page.text("error")).toBe(fill(es["Could not find {0}. Check the spelling and that this phone is on the same Wi-Fi or tailnet."]!, { 0: "automa.local" }));

    const reset = await open("es", [{
      ok: false,
      error: "Something at 192.168.1.20:37011 closed the connection. It is not an Automa server. Port 37011 looks like an Android Wireless debugging port, not Automa (Automa uses 3100 by default). Enter the address Automa prints when it starts, usually ending in :3100.",
    }], { wait: false });
    (reset.el("server") as HTMLInputElement).value = "192.168.1.20:37011";
    reset.el("connect").click();
    await vi.advanceTimersByTimeAsync(50);
    const hint = fill(es["Port {0} looks like an Android Wireless debugging port, not Automa (Automa uses 3100 by default)."]!, { 0: "37011" });
    expect(reset.text("error")).toBe(fill(es["Something at {0} closed the connection. It is not an Automa server.{1} Enter the address Automa prints when it starts, usually ending in :3100."]!, { 0: "192.168.1.20:37011", 1: ` ${hint}` }));
  });

  it("reads right to left in Arabic, addresses and values kept in their own direction", async () => {
    const ar = dictionary("ar");
    const page = await open("ar", [{ ok: false, error: "Could not find automa.local. Check the spelling and that this phone is on the same Wi-Fi or tailnet." }], { wait: false });
    expect(document.documentElement.dir).toBe("rtl");
    (page.el("server") as HTMLInputElement).value = "automa.local";
    page.el("connect").click();
    await vi.advanceTimersByTimeAsync(50);
    expect(page.text("error")).toBe(fill(ar["Could not find {0}. Check the spelling and that this phone is on the same Wi-Fi or tailnet."]!, { 0: `${FSI}automa.local${PDI}` }));
  });
});
