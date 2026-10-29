import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  get: vi.fn(),
  guestByToken: vi.fn(),
  postMessage: vi.fn(),
  resolveAiKey: vi.fn(),
  update: vi.fn(),
  touch: vi.fn(async () => undefined),
  expireShares: vi.fn(async () => []),
}));
const completeCode = vi.hoisted(() => vi.fn());
const openQuickTunnel = vi.hoisted(() => vi.fn());

vi.mock("../services/studio/service.js", () => ({ studioService: () => svc }));
vi.mock("../services/index.js", () => ({
  budgetService: () => ({ getCompanyInvocationBlock: async () => null }),
  heartbeatService: () => ({ cancelBudgetScopeWork: async () => undefined }),
  logActivity: vi.fn(async () => undefined),
}));
vi.mock("../services/studio/usage.js", () => ({
  studioUsageRecorder: () => ({ recordReply: vi.fn(), recordSuggestion: vi.fn() }),
}));
vi.mock("../services/studio/assistant.js", () => ({
  clearAssistantConversation: vi.fn(),
  completeCode,
  currentAssistantTurn: () => null,
  isAssistantRunning: () => false,
  markEditUndone: vi.fn(),
  readAssistantTranscript: vi.fn(async () => []),
  runAssistantTurn: vi.fn(),
  stopAssistant: vi.fn(),
}));
vi.mock("../services/studio/tunnel.js", () => ({
  cloudflaredPath: () => "/usr/bin/cloudflared",
  installCloudflared: vi.fn(),
  openQuickTunnel,
}));

const WORKSPACE = {
  id: "8d1c2b9e-4f6a-4c3d-9b2e-1a7f5e3d2c10",
  companyId: "company-1",
  name: "Shop",
  language: "html",
  description: null,
  sourceUrl: null,
  runCommand: null,
  createdByUserId: "local-board",
  shareEnabled: true,
  shareCode: "ABCD2345",
  shareExpiresAt: null,
  archivedAt: null,
  lastRunAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const BOARD = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
const GUEST_TOKEN = "guest-token-0123456789";

const realTmp = os.tmpdir();
let studioDir: string;
let uploadTmp: string;
let previousTmp: string | undefined;
let routes: typeof import("../routes/studio.js");
let runner: typeof import("../services/studio/runner.js");
let errorHandler: typeof import("../middleware/index.js")["errorHandler"];

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", routes.studioPublicRoutes({} as never));
  app.use("/api", routes.studioRoutes({} as never));
  app.use(errorHandler);
  return app;
}

beforeAll(async () => {
  studioDir = await mkdtemp(path.join(realTmp, "studio-routes-"));
  uploadTmp = await mkdtemp(path.join(realTmp, "studio-upload-tmp-"));
  process.env.PAPERCLIP_STUDIO_DIR = studioDir;
  // Project uploads are written under the temp folder; this one starts empty.
  previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = uploadTmp;
  await mkdir(path.join(studioDir, WORKSPACE.companyId, WORKSPACE.id, "files"), { recursive: true });
  routes = await import("../routes/studio.js");
  runner = await import("../services/studio/runner.js");
  ({ errorHandler } = await import("../middleware/index.js"));
});

afterAll(async () => {
  await routes.shutdownStudio();
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  delete process.env.PAPERCLIP_STUDIO_DIR;
  await rm(studioDir, { recursive: true, force: true });
  await rm(uploadTmp, { recursive: true, force: true });
});

beforeEach(() => {
  svc.get.mockResolvedValue(WORKSPACE);
  svc.guestByToken.mockImplementation(async (token: string) =>
    token === GUEST_TOKEN
      ? { workspace: WORKSPACE, collaborator: { id: "c0ffee00-0000-4000-8000-000000000001", displayName: "Sam", color: "#2F9E44" } }
      : null,
  );
  svc.postMessage.mockImplementation(async (input: { body: string; attachment?: unknown }) => ({ id: "m1", body: input.body, attachment: input.attachment ?? null }));
});

describe("Studio file names", () => {
  it("keeps accents, other scripts and emoji in uploaded names, and downloads them", async () => {
    const app = createApp(BOARD);
    const name = "café 日本 🎉.txt";
    const uploaded = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/upload`).attach("files", Buffer.from("hola"), name);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.paths).toEqual([name]);

    const downloaded = await request(app).get(`/api/studio/workspaces/${WORKSPACE.id}/download`).query({ path: name });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers["content-disposition"]).toBe(`attachment; filename="caf_ __ __.txt"; filename*=UTF-8''${encodeURIComponent(name)}`);
  });

  it("saves and serves chat attachments whatever their name", async () => {
    const app = createApp({ type: "none", source: "none" });
    for (const [sent, saved] of [
      ["naïve 😀 (1).txt", "naïve 😀 (1).txt"],
      [`${"日".repeat(100)}.txt`, "日".repeat(66)],
    ]) {
      const posted = await request(app).post("/api/studio-guest/messages").set("x-studio-guest", GUEST_TOKEN).field("body", "here").attach("file", Buffer.from("x"), sent);
      expect(posted.status, sent).toBe(201);
      expect(posted.body.message.attachment.name, sent).toBe(saved);

      const fetched = await request(app).get(`/api/studio-guest/shared/${posted.body.message.attachment.id}`).set("x-studio-guest", GUEST_TOKEN);
      expect(fetched.status, sent).toBe(200);
      expect(fetched.headers["content-disposition"], sent).toContain(`filename*=UTF-8''${encodeURIComponent(saved).replace(/[()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    }
  });

  it("reads no upload from someone without access", async () => {
    const outsider = createApp({ type: "agent", agentId: "agent-1", companyId: "company-2", source: "agent_key" });
    const refused = await request(outsider).post(`/api/studio/workspaces/${WORKSPACE.id}/upload`).attach("files", Buffer.alloc(4096, 1), "big.bin");
    expect(refused.status).toBe(403);
    const stranger = createApp({ type: "none", source: "none" });
    const unknown = await request(stranger).post("/api/studio-guest/messages").set("x-studio-guest", "wrong-token-0123456789").attach("file", Buffer.alloc(4096, 1), "big.bin");
    expect(unknown.status).toBe(401);
    expect(await readdir(uploadTmp)).toEqual([]);
  });
});

describe("Studio inline suggestions", () => {
  const body = { provider: "free", model: "any", path: "main.py", prefix: "pri", suffix: "" };

  it("answers a suggestion that is still wanted", async () => {
    svc.resolveAiKey.mockResolvedValue({ apiKey: "free", baseUrl: null });
    completeCode.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (signal.aborted) throw new Error("aborted");
      return 'print("hi")';
    });
    const res = await request(createApp(BOARD)).post(`/api/studio/workspaces/${WORKSPACE.id}/complete`).send(body).timeout(3000);
    expect(res.status).toBe(200);
    expect(res.body.completion).toBe('print("hi")');
  });

  it("stops the model call when the editor stops waiting", async () => {
    svc.resolveAiKey.mockResolvedValue({ apiKey: "free", baseUrl: null });
    const cancelled = new Promise<boolean>((settle) => {
      completeCode.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<string>((resolve) => {
            const timer = setTimeout(() => {
              settle(false);
              resolve("late");
            }, 2000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              settle(true);
              resolve("late");
            });
          }),
      );
    });
    await expect(request(createApp(BOARD)).post(`/api/studio/workspaces/${WORKSPACE.id}/complete`).send(body).timeout(500)).rejects.toThrow();
    expect(await cancelled).toBe(true);
  });
});

describe("Studio preview", () => {
  let upstream: Server;
  let seen: IncomingHttpHeaders | null = null;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": "app=1",
        "clear-site-data": '"*"',
        nel: '{"report_to":"x","max_age":86400}',
        "report-to": '{"group":"x","max_age":86400,"endpoints":[{"url":"https://example.invalid/r"}]}',
        "x-app": "kept",
      });
      res.end("hello");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("passes the app's answer without your cookies, and without headers that act on all of Automa", async () => {
    const runtime = runner.studioRuntime("preview-workspace");
    const address = upstream.address();
    runtime.previewToken = "preview-token-abcdefghijkl";
    runtime.state = { ...runtime.state, status: "running", port: typeof address === "object" && address ? address.port : null };
    const res = await request(createApp({ type: "none", source: "none" }))
      .get("/api/studio-preview/preview-token-abcdefghijkl/page")
      .set("cookie", "session=owner")
      .set("authorization", "Bearer owner");
    expect(res.status).toBe(200);
    expect(res.text).toBe("hello");
    expect(res.headers["x-app"]).toBe("kept");
    expect(res.headers["content-security-policy"]).toMatch(/^sandbox /);
    for (const header of ["set-cookie", "clear-site-data", "nel", "report-to"]) expect(res.headers[header], header).toBeUndefined();
    expect(seen?.cookie).toBeUndefined();
    expect(seen?.authorization).toBeUndefined();
    runtime.state = { ...runtime.state, status: "stopped", port: null };
  });
});

describe("Studio public link", () => {
  function fakeTunnel() {
    const tunnel = { onExit: (_detail: string) => {}, kill: vi.fn() };
    tunnel.kill.mockImplementation(() => {
      setImmediate(() => tunnel.onExit("cloudflared exited (signal)."));
      return true;
    });
    openQuickTunnel.mockImplementationOnce(async (_port: number, onExit: (detail: string) => void) => {
      tunnel.onExit = onExit;
      return { url: "https://test.trycloudflare.com", process: tunnel };
    });
    return tunnel;
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("ends with the app, on Stop and on Run again, and closing it is not an error", async () => {
    const app = createApp(BOARD);
    expect((await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/run`).send({})).status).toBe(200);

    const first = fakeTunnel();
    const opened = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/public-link`).send({});
    expect(opened.body.run).toMatchObject({ tunnelStatus: "on", publicUrl: "https://test.trycloudflare.com" });
    const stopped = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/stop`).send({});
    await settle();
    expect(first.kill).toHaveBeenCalled();
    expect(stopped.body.run).toMatchObject({ tunnelStatus: "off", publicUrl: null });
    expect(runner.studioRuntime(WORKSPACE.id).state).toMatchObject({ tunnelStatus: "off", publicUrl: null, tunnelError: null });

    expect((await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/run`).send({})).status).toBe(200);
    const second = fakeTunnel();
    await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/public-link`).send({});
    const rerun = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/run`).send({});
    await settle();
    expect(second.kill).toHaveBeenCalled();
    expect(rerun.body.run).toMatchObject({ status: "running", tunnelStatus: "off", publicUrl: null });

    const third = fakeTunnel();
    await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/public-link`).send({});
    const closed = await request(app).delete(`/api/studio/workspaces/${WORKSPACE.id}/public-link`);
    await settle();
    expect(third.kill).toHaveBeenCalled();
    expect(closed.body.run).toMatchObject({ tunnelStatus: "off", publicUrl: null });
    expect(runner.studioRuntime(WORKSPACE.id).state.tunnelError).toBeNull();
  });
});
