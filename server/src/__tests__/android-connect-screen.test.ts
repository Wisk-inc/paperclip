// @vitest-environment jsdom
/**
 * The Android app's connect screen (mobile/android/app/src/main/assets/connect)
 * while it waits for Automa on the phone: the real page and script, with a
 * stand-in for the app's bridge that answers each connect try in turn.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// From this file's own path (in a jsdom test, URL is jsdom's, which Node's
// fileURLToPath does not take).
const CONNECT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mobile", "android", "app", "src", "main", "assets", "connect");
const html = fs.readFileSync(path.join(CONNECT, "index.html"), "utf8");
const script = fs.readFileSync(path.join(CONNECT, "connect.js"), "utf8");

type Reply = Record<string, unknown>;
const SILENT: Reply = {
  ok: false,
  silent: true,
  error: "Nothing answers on this phone at 127.0.0.1:3100. Start Automa in Termux (see \"Run Automa on this phone\").",
};
const starting = (extra: Reply = {}): Reply => ({
  ok: false,
  starting: true,
  error: "Automa on this phone is still starting. Try again in a moment.",
  ...extra,
});
const READY: Reply = { ok: true, url: "http://127.0.0.1:3100", version: "1.9.10", locked: true, firstRun: false, signIn: false };

interface Page {
  connects: () => number;
  termuxStarts: () => number;
  text: (id: string) => string;
  hidden: (id: string) => boolean;
  stepState: (name: string) => string | null;
}

function load(replies: Reply[] | ((n: number) => Reply), state: Reply = {}): Page {
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
  window.history.replaceState(null, "", "/assets/connect/index.html?wait=1");
  let connects = 0;
  let termuxStarts = 0;
  const answer = (callId: string, reply: Reply) => {
    setTimeout(() => (window as any).__automaNative.resolve(callId, JSON.stringify(reply)), 10);
  };
  const next = (n: number): Reply => {
    if (typeof replies === "function") return replies(n);
    return replies[Math.min(n, replies.length - 1)]!;
  };
  (window as any).__automaKey = "page-key";
  (window as any).AutomaNative = {
    connect: (_key: string, _value: string, callId: string) => {
      answer(callId, next(connects));
      connects += 1;
    },
    getConnectState: () => JSON.stringify({
      serverUrl: "http://127.0.0.1:3100",
      recent: ["http://127.0.0.1:3100"],
      appVersion: "1.9.10",
      buildTime: "",
      phoneAddress: null,
      requested: null,
      waitFor: "http://127.0.0.1:3100",
      startedByRequest: true,
      ...state,
    }),
    isTermuxInstalled: () => true,
    termuxRunPermissionGranted: () => true,
    startAutomaInTermux: (_key: string, callId: string) => {
      termuxStarts += 1;
      answer(callId, { ok: true, output: "Automa is starting (log: ~/.automa/server.log)." });
    },
    hasServerBundle: () => true,
    getAuthState: () => JSON.stringify({ enabled: false, user: null }),
    haptic: () => undefined,
    copyText: () => undefined,
    openTermux: () => undefined,
  };
  new Function(script)();
  const el = (id: string) => document.getElementById(id)!;
  return {
    connects: () => connects,
    termuxStarts: () => termuxStarts,
    text: (id) => el(id).textContent ?? "",
    hidden: (id) => el(id).hidden,
    stepState: (name) => document.querySelector(`[data-step="${name}"]`)!.getAttribute("data-state"),
  };
}

/** Lets the page take `tries` more tries (each: the reply, then the 3 s wait). */
async function tries(count: number) {
  for (let i = 0; i < count; i += 1) await vi.advanceTimersByTimeAsync(3_010);
}

describe("the connect screen waiting for Automa on this phone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.scrollIntoView = () => undefined;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (window as any).__automaConnectRequested;
  });

  it("says which step Automa is on and how long it has waited, then opens when Automa is ready", async () => {
    const page = load([
      SILENT,
      SILENT,
      starting({ step: "Checking assigned tasks", seconds: 40, stepSeconds: 3, stepNumber: 13, stepTotal: 23 }),
      starting({ step: "Releasing stale task locks", seconds: 44, stepSeconds: 1, stepNumber: 17, stepTotal: 23 }),
      READY,
    ]);
    await vi.advanceTimersByTimeAsync(20);
    expect(page.hidden("wait")).toBe(false);
    expect(page.text("wait-status")).toBe("Waiting for Automa on this phone to answer…");
    expect(page.stepState("answer")).toBe("active");

    await tries(2);
    expect(page.text("wait-status")).toBe("Automa is starting up: checking assigned tasks…");
    expect(page.stepState("answer")).toBe("done");
    expect(page.stepState("ready")).toBe("active");
    expect(page.text("wait-time")).toMatch(/^Waiting \d+ s · step 13 of 23$/);

    await tries(1);
    expect(page.text("wait-status")).toBe("Automa is starting up: releasing stale task locks…");
    expect(page.text("wait-time")).toContain("step 17 of 23");

    await tries(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(page.hidden("wait")).toBe(true);
    expect(page.hidden("connected")).toBe(false);
    expect(page.text("connected-title")).toBe("Automa is running on this phone");
  });

  it("keeps waiting while Automa says it is starting, however long (no 100-try limit)", async () => {
    const page = load(() => starting({ step: "Resuming waiting work", seconds: 300, stepSeconds: 30, stepNumber: 10, stepTotal: 23 }));
    await tries(150);
    expect(page.hidden("wait")).toBe(false);
    expect(page.text("error")).toBe("");
    expect(page.text("wait-status")).toBe("Automa is starting up: resuming waiting work…");
    expect(page.connects()).toBeGreaterThan(140);
  });

  it("says Automa stopped answering once it goes quiet after answering, and asks Termux to start it once", async () => {
    let n = 0;
    const page = load(() => {
      n += 1;
      if (n === 1) return starting({ step: "Checking assigned tasks", stepNumber: 13, stepTotal: 23 });
      if (n <= 8) return SILENT;
      if (n === 9) return starting({ step: "Starting plugins", stepNumber: 5, stepTotal: 23 });
      return READY;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(page.stepState("ready")).toBe("active");

    // Two quiet tries are a moment: still "starting".
    await tries(2);
    expect(page.stepState("ready")).toBe("active");
    expect(page.termuxStarts()).toBe(0);

    // The third: it stopped. The steps go back to "Automa answers", the help says why, and Termux is asked once.
    await tries(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(page.stepState("answer")).toBe("active");
    expect(page.stepState("ready")).toBe("todo");
    expect(page.hidden("wait-help")).toBe(false);
    expect(page.text("wait-help")).toContain("Android may have closed Termux, or Automa ran into an error");
    expect(page.hidden("wait-termux")).toBe(false);
    expect(page.termuxStarts()).toBe(1);

    await tries(4);
    expect(page.termuxStarts()).toBe(1);

    // It answers again: starting, the silence help goes, then it opens.
    await tries(1);
    expect(page.stepState("ready")).toBe("active");
    expect(page.text("wait-status")).toBe("Automa is starting up: starting plugins…");
    expect(page.hidden("wait-help")).toBe(true);
    await tries(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(page.hidden("connected")).toBe(false);
  });

  it("calls out a step Automa has been on for five minutes", async () => {
    const page = load([starting({ step: "Starting plugins", seconds: 400, stepSeconds: 301, stepNumber: 5, stepTotal: 23 })]);
    await vi.advanceTimersByTimeAsync(20);
    expect(page.hidden("wait-help")).toBe(false);
    expect(page.text("wait-help")).toContain("Automa has been on this step for 5 min 01 s");
  });

  it("stops after five minutes with nothing answering, and says what to do", async () => {
    const page = load(() => SILENT);
    await vi.advanceTimersByTimeAsync(20);
    await tries(110);
    expect(page.hidden("wait")).toBe(true);
    expect(page.text("error")).toContain("Nothing answers on this phone");
  });

  it("an Automa that answered and then went quiet for five minutes says so when the page stops", async () => {
    let n = 0;
    const page = load(() => (++n === 1 ? starting() : SILENT));
    await vi.advanceTimersByTimeAsync(20);
    await tries(110);
    expect(page.hidden("wait")).toBe(true);
    expect(page.text("error")).toContain("stopped answering while it was starting up, and has not come back in 5 minutes");
  });

  it("a connect request from Termux mid-wait keeps the wait going instead of starting it over", async () => {
    const page = load(() => SILENT);
    await vi.advanceTimersByTimeAsync(20);
    await tries(10);
    const waited = page.text("wait-time");
    expect(waited).toMatch(/^Waiting 3\d s$/);

    const before = page.connects();
    (window as any).__automaConnectRequested("http://127.0.0.1:3100");
    await vi.advanceTimersByTimeAsync(20);
    // Asked at once, and the wait carries on: the same clock, no second loop.
    expect(page.connects()).toBe(before + 1);
    expect(page.text("wait-status")).toBe("Waiting for Automa to answer…");
    expect(page.text("wait-time")).toMatch(/^Waiting 3\d s$/);
    const after = page.connects();
    await tries(5);
    expect(page.connects()).toBe(after + 5);
  });

  it("a connect request when the page is not waiting starts waiting, leaving the start to Termux", async () => {
    const page = load([SILENT, READY], { waitFor: null });
    await vi.advanceTimersByTimeAsync(20);
    expect(page.hidden("wait")).toBe(true);
    (window as any).__automaConnectRequested("http://127.0.0.1:3100");
    await vi.advanceTimersByTimeAsync(20);
    expect(page.hidden("wait")).toBe(false);
    expect(page.stepState("termux")).toBe("skipped");
    await tries(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(page.hidden("connected")).toBe(false);
    expect(page.termuxStarts()).toBe(0);
  });
});
