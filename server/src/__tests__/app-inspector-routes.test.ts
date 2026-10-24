import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", key: null as string | null, create: vi.fn() }));

vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => state.root }));
vi.mock("../services/ai-connections.js", () => ({
  aiConnectionService: () => ({ credentialForProvider: async () => state.key }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: state.create };
  },
}));

import { __resetInspector } from "../services/app-inspector/inspector.js";

const COMPANY = "company-1";
const PROJECT = "66666666-6666-4666-8666-666666666666";

async function createApp(actor: Record<string, unknown> = {}, hosted = false) {
  const [{ appInspectorRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/app-inspector.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "local-board", companyIds: [COMPANY], source: "local_implicit", isInstanceAdmin: true, ...actor };
    next();
  });
  app.use("/api", appInspectorRoutes({} as any, hosted ? { deploymentMode: "authenticated", deploymentExposure: "public" } : { deploymentMode: "local_trusted", deploymentExposure: "private" }));
  app.use(errorHandler);
  return app;
}

describe("App Inspector routes", () => {
  beforeEach(() => {
    state.root = mkdtempSync(path.join(os.tmpdir(), "automa-inspector-routes-"));
    state.key = "sk-ant-test";
    state.create.mockReset();
    __resetInspector();
    const dir = path.join(state.root, "app-inspector", PROJECT);
    mkdirSync(path.join(dir, "decoded"), { recursive: true });
    mkdirSync(path.join(dir, "java", "sources", "com", "example"), { recursive: true });
    writeFileSync(path.join(dir, "decoded", "AndroidManifest.xml"), '<manifest package="com.example"/>');
    writeFileSync(path.join(dir, "decoded", "icon.png"), Buffer.from([0x89, 0x50, 0x00]));
    writeFileSync(path.join(dir, "java", "sources", "com", "example", "Main.java"), "class Main {}");
    writeFileSync(
      path.join(dir, "project.json"),
      JSON.stringify({ id: PROJECT, companyId: COMPANY, label: "Example", status: "ready", java: "ready", createdAt: "2026-10-24T00:00:00.000Z" }),
    );
  });
  afterEach(() => {
    __resetInspector();
    rmSync(state.root, { recursive: true, force: true });
  });

  it("asks Claude to explain a decoded file, with the file in the prompt", async () => {
    state.create.mockResolvedValue({ content: [{ type: "text", text: "The app's manifest." }] });
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY}/app-inspector/projects/${PROJECT}/explain`)
      .send({ path: "AndroidManifest.xml" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ explanation: "The app's manifest." });
    const call = state.create.mock.calls[0]![0];
    expect(call.messages[0].content).toContain('<manifest package="com.example"/>');
    expect(call.messages[0].content).toContain("decoded by apktool");
  });

  it("explains decompiled Java too", async () => {
    state.create.mockResolvedValue({ content: [{ type: "text", text: "An empty class." }] });
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY}/app-inspector/projects/${PROJECT}/explain`)
      .send({ path: "com/example/Main.java", view: "java" });
    expect(res.status).toBe(200);
    expect(state.create.mock.calls[0]![0].messages[0].content).toContain("Java decompiled by jadx");
  });

  it("says to add a key when there is none, and never calls Claude", async () => {
    state.key = null;
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY}/app-inspector/projects/${PROJECT}/explain`)
      .send({ path: "AndroidManifest.xml" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Anthropic API key/);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("won't send a binary file to Claude", async () => {
    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY}/app-inspector/projects/${PROJECT}/explain`)
      .send({ path: "icon.png" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/binary/);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("keeps the server's paths out of error messages", async () => {
    const res = await request(await createApp()).get(
      `/api/companies/${COMPANY}/app-inspector/projects/${PROJECT}/file?view=files&path=${encodeURIComponent("missing.xml")}`,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("That file or folder isn't there.");
    expect(JSON.stringify(res.body)).not.toContain(state.root);
  });

  it("is only for the device's operator", async () => {
    const member = await createApp({ source: "session", isInstanceAdmin: false });
    expect((await request(member).get(`/api/companies/${COMPANY}/app-inspector/projects`)).status).toBe(403);
    const hosted = await createApp({}, true);
    expect((await request(hosted).get(`/api/companies/${COMPANY}/app-inspector/projects`)).status).toBe(403);
  });
});
