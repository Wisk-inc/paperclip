import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", spawned: [] as string[][], hold: false, release: [] as Array<() => void> }));
const logged = vi.hoisted(() => [] as Array<{ action: string; entityId: string }>);
vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => state.root }));
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async (_db: unknown, entry: { action: string; entityId: string }) => {
    logged.push({ action: entry.action, entityId: entry.entityId });
  }),
}));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ credentialForProvider: async () => null }) }));

// Each job is a short real process; what matters is what it was asked to do.
// A held job stays "working" until the test lets it go.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      state.spawned.push(args.slice(1));
      if (!state.hold) return actual.spawn("bash", ["-c", "true"], options);
      const child = actual.spawn("bash", ["-c", "read line"], { ...options, stdio: ["pipe", "pipe", "pipe"] });
      state.release.push(() => child.stdin?.end("go\n"));
      return child;
    },
  };
});

const { __resetInspector } = await import("../services/app-inspector/inspector.js");

const COMPANY = "company-1";
const APK = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);

async function createApp(companyIds = [COMPANY]) {
  const [{ appInspectorRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/app-inspector.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "local-board", companyIds, source: "local_implicit", isInstanceAdmin: false };
    next();
  });
  app.use("/api", appInspectorRoutes({} as any, { deploymentMode: "local_trusted", deploymentExposure: "private" }));
  app.use(errorHandler);
  return app;
}

describe("App Inspector: decoding a project again", () => {
  const saved = process.env.PREFIX;
  let app: express.Express;
  const base = `/api/companies/${COMPANY}/app-inspector`;
  const dirOf = (id: string) => path.join(state.root, "app-inspector", id);
  const read = async (id: string) => (await request(app).get(`${base}/projects/${id}`)).body.project;
  const settled = (id: string) =>
    vi.waitFor(async () => {
      const project = await read(id);
      expect(project.status).not.toBe("decoding");
      expect(project.java).not.toBe("working");
    });
  /** A project the way the broken APK button left it: decoded with everything off. */
  async function openedWithEverythingOff() {
    const res = await request(app).put(`${base}/uploads?label=shop&res=0&src=0&java=0`).set("Content-Type", "application/octet-stream").send(APK);
    expect(res.status).toBe(201);
    const id = res.body.project.id as string;
    await settled(id);
    return id;
  }

  beforeEach(async () => {
    state.root = mkdtempSync(path.join(os.tmpdir(), "automa-inspector-redecode-"));
    state.spawned = [];
    state.hold = false;
    state.release = [];
    logged.length = 0;
    delete process.env.PREFIX;
    __resetInspector();
    app = await createApp();
  });
  afterEach(async () => {
    for (const release of state.release) release();
    __resetInspector();
    if (saved !== undefined) process.env.PREFIX = saved;
    rmSync(state.root, { recursive: true, force: true });
  });

  it("reads the kept APK again with resources, code and Java, and replaces what was decoded before", async () => {
    const id = await openedWithEverythingOff();
    // What the first decode left, an edit among it, and the conversation about the app.
    mkdirSync(path.join(dirOf(id), "decoded", "res"), { recursive: true });
    writeFileSync(path.join(dirOf(id), "decoded", "res", "edited.xml"), "<old/>");
    mkdirSync(path.join(dirOf(id), "java", "sources"), { recursive: true });
    writeFileSync(path.join(dirOf(id), "java", "sources", "Old.java"), "class Old {}");
    writeFileSync(path.join(dirOf(id), "chat.json"), JSON.stringify({ messages: [{ role: "user", text: "What is this app?" }] }));
    state.spawned = [];

    const again = await request(app).post(`${base}/projects/${id}/decode`).send({});
    expect(again.status).toBe(200);
    expect(again.body.project).toMatchObject({ id, status: "decoding", decoded: false, options: { resources: true, sources: true, java: true }, hasOutput: false });
    const decode = state.spawned.find((args) => args[0] === "decode") ?? [];
    expect(decode[1]).toBe(path.join(dirOf(id), "input.apk"));
    expect(decode).not.toContain("--no-res");
    expect(decode).not.toContain("--no-src");
    expect(state.spawned.map((args) => args[0]).sort()).toEqual(["decode", "java"]);
    // The old files are gone before the new ones are written; the chat and the APK stay.
    expect(existsSync(path.join(dirOf(id), "decoded", "res", "edited.xml"))).toBe(false);
    expect(existsSync(path.join(dirOf(id), "java", "sources", "Old.java"))).toBe(false);
    expect(existsSync(path.join(dirOf(id), "chat.json"))).toBe(true);
    expect(existsSync(path.join(dirOf(id), "input.apk"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dirOf(id), "project.json"), "utf8")).options).toEqual({ resources: true, sources: true, java: true });
    expect(logged).toContainEqual({ action: "app_inspector.decoded_again", entityId: id });
    await settled(id);
  });

  it("waits for a job that is still running", async () => {
    state.hold = true;
    const res = await request(app).put(`${base}/uploads?label=shop&java=0`).set("Content-Type", "application/octet-stream").send(APK);
    const id = res.body.project.id as string;
    expect((await read(id)).status).toBe("decoding");
    state.spawned = [];

    const again = await request(app).post(`${base}/projects/${id}/decode`).send({});
    expect(again.status).toBe(422);
    expect(again.body.error).toBe("Still working; wait for it to finish.");
    expect(state.spawned).toEqual([]);
    expect(logged.map((entry) => entry.action)).not.toContain("app_inspector.decoded_again");
    for (const release of state.release) release();
    await settled(id);
  });

  it("says so when the APK the project was opened from is no longer kept", async () => {
    const id = await openedWithEverythingOff();
    rmSync(path.join(dirOf(id), "input.apk"));
    state.spawned = [];
    const again = await request(app).post(`${base}/projects/${id}/decode`).send({});
    expect(again.status).toBe(422);
    expect(again.body.error).toBe("This project no longer has the APK it was opened from. Open the APK again instead.");
    expect(state.spawned).toEqual([]);
  });

  it("does not leave the project waiting for a job that never started, when the old files cannot be removed", async () => {
    const id = await openedWithEverythingOff();
    mkdirSync(path.join(dirOf(id), "decoded"), { recursive: true });
    writeFileSync(path.join(dirOf(id), "decoded", "kept.txt"), "still here");
    state.spawned = [];
    const fsPromises = (await import("node:fs/promises")).default;
    const rm = vi.spyOn(fsPromises, "rm").mockRejectedValue(Object.assign(new Error("EACCES: permission denied, rmdir '/data/secret/place'"), { code: "EACCES" }));
    try {
      const again = await request(app).post(`${base}/projects/${id}/decode`).send({});
      expect(again.status).toBe(422);
      expect(again.body.error).toBe("The files decoded before could not be removed, so the APK was not decoded again.");
      // No folder of the server in the answer, no job started, and the project says it failed.
      expect(JSON.stringify(again.body)).not.toContain("/data/secret");
      expect(state.spawned).toEqual([]);
      const after = await read(id);
      expect(after.status).toBe("failed");
      expect(after.java).not.toBe("working");
      expect(after.error).toBe("The files decoded before could not be removed, so the APK was not decoded again.");
      expect(logged.map((entry) => entry.action)).not.toContain("app_inspector.decoded_again");
    } finally {
      rm.mockRestore();
    }
    // Asked again once the files can go: it starts.
    const retry = await request(app).post(`${base}/projects/${id}/decode`).send({});
    expect(retry.status).toBe(200);
    expect(retry.body.project.status).toBe("decoding");
    await settled(id);
  });

  it("is refused for another organization's project", async () => {
    const id = await openedWithEverythingOff();
    state.spawned = [];
    const other = await createApp(["company-2"]);
    const again = await request(other).post(`/api/companies/company-2/app-inspector/projects/${id}/decode`).send({});
    expect(again.status).toBe(404);
    expect(state.spawned).toEqual([]);
  });
});
