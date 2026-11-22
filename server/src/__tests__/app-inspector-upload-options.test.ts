import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", spawned: [] as string[][] }));
vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => state.root }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ credentialForProvider: async () => null }) }));

// Each job is a short real process; what matters is what it was asked to do.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      state.spawned.push(args.slice(1));
      return actual.spawn("bash", ["-c", "true"], options);
    },
  };
});

const { __resetInspector } = await import("../services/app-inspector/inspector.js");

const COMPANY = "company-1";
const APK = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
const ALL = { resources: true, sources: true, java: true };

async function createApp() {
  const [{ appInspectorRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/app-inspector.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "local-board", companyIds: [COMPANY], source: "local_implicit", isInstanceAdmin: true };
    next();
  });
  app.use("/api", appInspectorRoutes({} as any, { deploymentMode: "local_trusted", deploymentExposure: "private" }));
  app.use(errorHandler);
  return app;
}

describe("App Inspector: what an upload decodes", () => {
  const saved = process.env.PREFIX;
  let app: express.Express;

  const upload = (query: string) =>
    request(app).put(`/api/companies/${COMPANY}/app-inspector/uploads?${query}`).set("Content-Type", "application/octet-stream").send(APK);
  const decodeArgs = () => state.spawned.find((args) => args[0] === "decode") ?? [];
  const kept = (id: string) => JSON.parse(readFileSync(path.join(state.root, "app-inspector", id, "project.json"), "utf8")) as { options: unknown };
  /** The jobs end before the folder goes, so none writes into a folder that was removed. */
  const settled = (id: string) =>
    vi.waitFor(async () => {
      const project = (await request(app).get(`/api/companies/${COMPANY}/app-inspector/projects/${id}`)).body.project;
      expect(project.status).not.toBe("decoding");
      expect(project.java).not.toBe("working");
    });

  beforeEach(async () => {
    state.root = mkdtempSync(path.join(os.tmpdir(), "automa-inspector-upload-"));
    state.spawned = [];
    delete process.env.PREFIX;
    __resetInspector();
    app = await createApp();
  });
  afterEach(() => {
    __resetInspector();
    if (saved !== undefined) process.env.PREFIX = saved;
    rmSync(state.root, { recursive: true, force: true });
  });

  it("decodes resources, smali and Java when the page says nothing about them", async () => {
    const res = await upload("label=x");
    expect(res.status).toBe(201);
    expect(res.body.project.options).toEqual(ALL);
    expect(decodeArgs()).not.toContain("--no-res");
    expect(decodeArgs()).not.toContain("--no-src");
    expect(state.spawned.map((args) => args[0]).sort()).toEqual(["decode", "java"]);
    // What is kept for the next start says the same.
    expect(kept(res.body.project.id).options).toEqual(ALL);
    await settled(res.body.project.id);
  });

  it("leaves out only what the page turned off", async () => {
    const res = await upload("label=x&res=0&java=0");
    expect(res.status).toBe(201);
    expect(res.body.project.options).toEqual({ resources: false, sources: true, java: false });
    expect(decodeArgs()).toContain("--no-res");
    expect(decodeArgs()).not.toContain("--no-src");
    expect(state.spawned.map((args) => args[0])).toEqual(["decode"]);
    expect(kept(res.body.project.id).options).toEqual({ resources: false, sources: true, java: false });
    await settled(res.body.project.id);
  });

  it("decodes what was not turned off for an APK opened by its path", async () => {
    const apk = path.join(state.root, "app.apk");
    writeFileSync(apk, APK);
    const res = await request(app)
      .post(`/api/companies/${COMPANY}/app-inspector/projects`)
      .send({ source: { kind: "path", apkPath: apk }, options: { sources: false } });
    expect(res.status).toBe(201);
    expect(res.body.project.options).toEqual({ resources: true, sources: false, java: true });
    expect(decodeArgs()).toEqual(expect.arrayContaining(["--no-src"]));
    expect(decodeArgs()).not.toContain("--no-res");
    await settled(res.body.project.id);
  });
});
