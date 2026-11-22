import { promises as fsp, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => state.root }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ credentialForProvider: async () => null }) }));

import { __resetInspector, searchInspector } from "../services/app-inspector/inspector.js";

const COMPANY = "company-1";
const PROJECT = "88888888-8888-4888-8888-888888888888";
const sources = (...parts: string[]) => path.join(state.root, "app-inspector", PROJECT, "java", "sources", ...parts);

/** One folder of `count` Java files, the way jadx leaves a renamed app's classes in `defpackage`. */
function flatFolder(count: number, text = "class A { void run() { helper(); } }\n") {
  const flat = sources("defpackage");
  mkdirSync(flat, { recursive: true });
  const first = path.join(flat, "C0000a.java");
  writeFileSync(first, text);
  for (let index = 1; index < count; index += 1) linkSync(first, path.join(flat, `C${String(index).padStart(4, "0")}a.java`));
}

describe("App Inspector search limits", () => {
  beforeEach(() => {
    state.root = mkdtempSync(path.join(os.tmpdir(), "automa-inspector-search-"));
    __resetInspector();
    const dir = path.join(state.root, "app-inspector", PROJECT);
    mkdirSync(path.join(dir, "decoded"), { recursive: true });
    mkdirSync(sources(), { recursive: true });
    writeFileSync(path.join(dir, "project.json"), JSON.stringify({ id: PROJECT, companyId: COMPANY, label: "Example", status: "ready", decoded: true, java: "ready", createdAt: "2026-11-22T00:00:00.000Z" }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetInspector();
    rmSync(state.root, { recursive: true, force: true });
  });

  it("stops at its deadline inside one big folder, and says the search was cut short", async () => {
    flatFolder(300);
    // A clock the test owns: every file read takes 100 ms of it.
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const actual = fsp.readFile.bind(fsp);
    const read = vi.spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      clock += 100;
      return actual(...args);
    }) as typeof fsp.readFile);

    const found = await searchInspector(COMPANY, PROJECT, "java", "no such text anywhere", "text", { deadlineMs: 450 });
    expect(found).toEqual({ results: [], truncated: true });
    // Five reads pass the 450 ms; the 300 files of the folder were not all read.
    expect(read.mock.calls.length).toBe(5);
  });

  it("reads every file when there is time, and is then not cut short", async () => {
    flatFolder(40);
    const read = vi.spyOn(fsp, "readFile");
    const found = await searchInspector(COMPANY, PROJECT, "java", "no such text anywhere", "text");
    expect(found).toEqual({ results: [], truncated: false });
    expect(read.mock.calls.length).toBe(40);
  });

  it("stops when the page that asked has gone", async () => {
    flatFolder(300);
    const gone = new AbortController();
    const actual = fsp.readFile.bind(fsp);
    const read = vi.spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      if (read.mock.calls.length === 3) gone.abort();
      return actual(...args);
    }) as typeof fsp.readFile);
    const found = await searchInspector(COMPANY, PROJECT, "java", "no such text anywhere", "text", { signal: gone.signal });
    expect(found.truncated).toBe(true);
    expect(read.mock.calls.length).toBe(3);
  });

  it("says so when the result limit cuts a folder short", async () => {
    flatFolder(250);
    const byName = await searchInspector(COMPANY, PROJECT, "java", "C0", "name");
    expect(byName.results).toHaveLength(200);
    expect(byName.truncated).toBe(true);

    const byText = await searchInspector(COMPANY, PROJECT, "java", "helper", "text");
    expect(byText.results).toHaveLength(200);
    expect(byText.truncated).toBe(true);
  });

  it("is not cut short when a folder holds exactly as many matches as the limit", async () => {
    flatFolder(200);
    const byName = await searchInspector(COMPANY, PROJECT, "java", "C0", "name");
    expect(byName.results).toHaveLength(200);
    expect(byName.truncated).toBe(false);
  });

  it("keeps to the result limit for folders too", async () => {
    for (let index = 0; index < 250; index += 1) mkdirSync(sources("pkg", `match${index}`), { recursive: true });
    const byName = await searchInspector(COMPANY, PROJECT, "java", "match", "name");
    expect(byName.results).toHaveLength(200);
    expect(byName.truncated).toBe(true);
  });

  it("stops at its entry limit inside one folder", async () => {
    // More entries in one folder than a search walks (53,500).
    const flat = sources("defpackage");
    mkdirSync(flat, { recursive: true });
    writeFileSync(path.join(flat, "f0.bin"), "");
    for (let index = 1; index < 53_700; index += 1) linkSync(path.join(flat, "f0.bin"), path.join(flat, `f${index}.bin`));
    const found = await searchInspector(COMPANY, PROJECT, "java", "no-such-name", "name");
    expect(found).toEqual({ results: [], truncated: true });
  }, 60_000);

  it("stops a search whose page went away, through the route", async () => {
    flatFolder(300);
    const [{ appInspectorRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/app-inspector.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", companyIds: [COMPANY], source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", appInspectorRoutes({} as any, { deploymentMode: "local_trusted", deploymentExposure: "private" }));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${COMPANY}/app-inspector/projects/${PROJECT}/search?view=java&mode=text&q=${encodeURIComponent("no such text anywhere")}`;

    // Every read waits a little, so the search is still running when the page leaves.
    const actual = fsp.readFile.bind(fsp);
    const read = vi.spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return actual(...args);
    }) as typeof fsp.readFile);
    try {
      const page = http.get(url);
      page.on("error", () => undefined);
      await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(3));
      page.destroy();
      // The search ends soon after, far short of the folder's 300 files.
      let last = -1;
      await vi.waitFor(() => {
        const now = read.mock.calls.length;
        const settled = now === last;
        last = now;
        expect(settled).toBe(true);
      }, { interval: 150, timeout: 10_000 });
      expect(read.mock.calls.length).toBeLessThan(100);

      // A search the page waits for is not stopped: it reads the whole folder.
      read.mockRestore();
      const whole = vi.spyOn(fsp, "readFile");
      const body = await new Promise<string>((resolve, reject) => {
        http.get(url, (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve(text));
        }).on("error", reject);
      });
      expect(JSON.parse(body)).toEqual({ results: [], truncated: false });
      expect(whole.mock.calls.length).toBe(300);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60_000);
});
