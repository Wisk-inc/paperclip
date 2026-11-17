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
  /** What the page asked of the app beyond connecting: safe starts, troubleshooter runs, copies, Termux opened. */
  asked: string[];
  click: (id: string) => void;
  text: (id: string) => string;
  hidden: (id: string) => boolean;
  stepState: (name: string) => string | null;
}

function load(
  replies: Reply[] | ((n: number) => Reply),
  state: Reply = {},
  /** The app's answers to Safe start and Troubleshoot (1.9.12 on). */
  tools: { safeStart?: Reply; troubleshoot?: Reply } = {},
): Page {
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
  window.history.replaceState(null, "", "/assets/connect/index.html?wait=1");
  let connects = 0;
  let termuxStarts = 0;
  const asked: string[] = [];
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
    safeStartAutomaInTermux: (_key: string, callId: string) => {
      asked.push("safe start");
      answer(callId, tools.safeStart ?? { ok: true, output: "Automa is starting in safe mode (log: ~/.automa/server.log)." });
    },
    runTroubleshooter: (_key: string, callId: string) => {
      asked.push("troubleshoot");
      answer(callId, tools.troubleshoot ?? { ok: true, output: "Summary\nNo problems found.", problems: false });
    },
    hasServerBundle: () => true,
    getAuthState: () => JSON.stringify({ enabled: false, user: null }),
    haptic: () => undefined,
    copyText: (_key: string, text: string) => asked.push(`copy ${text}`),
    openTermux: () => asked.push("open termux"),
  };
  new Function(script)();
  const el = (id: string) => document.getElementById(id)!;
  return {
    connects: () => connects,
    termuxStarts: () => termuxStarts,
    asked,
    click: (id) => el(id).click(),
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

  describe("when Automa on this phone won't start", () => {
    /** Answers that it is starting, then goes quiet, then (from try `readyFrom` on) is ready. */
    const quietThenReady = (readyFrom = Number.POSITIVE_INFINITY) => {
      let n = 0;
      return () => {
        n += 1;
        if (n === 1) return starting({ step: "Starting plugins", stepNumber: 5, stepTotal: 23 });
        return n >= readyFrom ? READY : SILENT;
      };
    };

    it("offers Safe start and Troubleshoot only once something is wrong", async () => {
      const page = load(quietThenReady());
      await vi.advanceTimersByTimeAsync(20);
      expect(page.hidden("phone-tools")).toBe(true);
      await tries(3);
      await vi.advanceTimersByTimeAsync(20);
      expect(page.text("wait-help")).toContain("Android may have closed Termux");
      expect(page.hidden("phone-tools")).toBe(false);
    });

    it("Safe start asks Termux for a safe start and waits for Automa again, with a fresh clock", async () => {
      const page = load(quietThenReady(9));
      await vi.advanceTimersByTimeAsync(20);
      await tries(3);
      await vi.advanceTimersByTimeAsync(20);
      page.click("phone-safe");
      await vi.advanceTimersByTimeAsync(20);
      expect(page.asked).toEqual(["safe start"]);
      expect(page.text("wait-status")).toBe("Automa is starting in safe mode. Waiting for it to answer…");
      expect(page.text("wait-time")).toMatch(/^Waiting [0-9] s$/);
      await tries(5);
      await vi.advanceTimersByTimeAsync(500);
      expect(page.hidden("connected")).toBe(false);
      expect(page.hidden("phone-tools")).toBe(true);
    });

    it("Troubleshoot shows the report in the app, then waits for the Automa it started", async () => {
      const report = "Database\n  ✓ Fixed: Cleared PostgreSQL's lock file from before.\nSummary\n1 problem(s) need you (marked ✗ above).";
      const page = load(quietThenReady(9), {}, { troubleshoot: { ok: true, output: report, problems: true } });
      await vi.advanceTimersByTimeAsync(20);
      await tries(3);
      await vi.advanceTimersByTimeAsync(20);
      page.click("phone-troubleshoot");
      expect(page.hidden("troubleshoot-report")).toBe(false);
      expect(page.text("troubleshoot-title")).toBe("Troubleshooting…");
      await vi.advanceTimersByTimeAsync(20);
      expect(page.asked).toEqual(["troubleshoot"]);
      expect(page.text("troubleshoot-title")).toBe("Found problems: what to do is in the report");
      expect(page.text("troubleshoot-text")).toBe(report);
      expect(page.text("wait-status")).toBe("Waiting for Automa to answer…");
      await tries(5);
      await vi.advanceTimersByTimeAsync(500);
      expect(page.hidden("connected")).toBe(false);
      // The report stays until it is closed.
      expect(page.hidden("troubleshoot-report")).toBe(false);
      page.click("troubleshoot-close");
      expect(page.hidden("troubleshoot-report")).toBe(true);
    });

    it("copies automa keep-alive for Termux when the report asks for it", async () => {
      const report = "Android\n  ✗ Android 14 ends Termux's processes when apps together run too many.\n      Run: automa keep-alive (it uses Wireless debugging once; the setting stays after restarts)";
      const page = load(quietThenReady(), {}, { troubleshoot: { ok: true, output: report, problems: true } });
      await vi.advanceTimersByTimeAsync(20);
      await tries(3);
      await vi.advanceTimersByTimeAsync(20);
      page.click("phone-troubleshoot");
      await vi.advanceTimersByTimeAsync(20);
      expect(page.text("troubleshoot-termux")).toBe("Copy automa keep\u2011alive and open Termux");
      page.click("troubleshoot-termux");
      expect(page.asked).toEqual(["troubleshoot", "copy automa keep-alive", "open termux"]);
    });

    it("says what Termux needs when it refuses to run the troubleshooter, and copies the fix", async () => {
      const fix = "sed -i 's/^# *allow-external-apps.*/allow-external-apps = true/' ~/.termux/termux.properties";
      const page = load(quietThenReady(), {}, {
        troubleshoot: { ok: false, reason: "not_allowed", error: "Termux needs one setting before Automa can start it: allow-external-apps.", fix },
      });
      await vi.advanceTimersByTimeAsync(20);
      await tries(3);
      await vi.advanceTimersByTimeAsync(20);
      page.click("phone-troubleshoot");
      await vi.advanceTimersByTimeAsync(20);
      expect(page.text("troubleshoot-title")).toBe("Termux needs one setting first");
      expect(page.text("troubleshoot-text")).toContain(fix);
      page.click("troubleshoot-termux");
      expect(page.asked).toEqual(["troubleshoot", `copy ${fix}`, "open termux"]);
    });

    it("keeps Safe start and Troubleshoot once the page stops waiting, and Safe start waits again", async () => {
      const page = load(() => SILENT);
      await vi.advanceTimersByTimeAsync(20);
      await tries(110);
      expect(page.hidden("wait")).toBe(true);
      expect(page.hidden("phone-tools")).toBe(false);
      page.click("phone-safe");
      await vi.advanceTimersByTimeAsync(20);
      expect(page.hidden("wait")).toBe(false);
      expect(page.text("error")).toBe("");
      expect(page.text("wait-status")).toBe("Automa is starting in safe mode. Waiting for it to answer…");
    });

    it("never offers them for a server on another computer", async () => {
      const page = load(() => SILENT, { serverUrl: "http://192.168.1.20:3100", waitFor: "http://192.168.1.20:3100" });
      await vi.advanceTimersByTimeAsync(20);
      await tries(110);
      expect(page.hidden("phone-tools")).toBe(true);
    });

    it("Refresh asks Automa at once instead of at the next try", async () => {
      const page = load(() => SILENT);
      await vi.advanceTimersByTimeAsync(20);
      const before = page.connects();
      page.click("wait-refresh");
      await vi.advanceTimersByTimeAsync(20);
      expect(page.connects()).toBe(before + 1);
    });
  });
});
