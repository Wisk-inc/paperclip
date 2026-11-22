import { randomBytes } from "node:crypto";
import type { ReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PuterHttpError } from "@paperclipai/shared/puter-ai";
import { conflict } from "../errors.js";
import { DEFAULT_JSON_BODY_LIMIT } from "../http/body-limits.js";

// Every file the routes open for reading, so a test can see whether it was closed again.
const opened = vi.hoisted(() => [] as ReadStream[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args);
      opened.push(stream);
      return stream;
    },
  };
});

const svc = vi.hoisted(() => ({
  get: vi.fn(),
  guestByToken: vi.fn(),
  postMessage: vi.fn(),
  resolveAiKey: vi.fn(),
  update: vi.fn(),
  touch: vi.fn(async () => undefined),
  expireShares: vi.fn(async () => []),
  getChangeRequest: vi.fn(),
  resolveChangeRequest: vi.fn(),
  reopenChangeRequest: vi.fn(async () => undefined),
  removeCollaborator: vi.fn(),
  enableShare: vi.fn(),
  disableShare: vi.fn(),
  remove: vi.fn(),
}));
const completeCode = vi.hoisted(() => vi.fn());
/** The organization's budget hard stop: null while spending is allowed. */
const budget = vi.hoisted(() => ({ block: null as null | { reason: string } }));
const assistant = vi.hoisted(() => ({
  runAssistantTurn: vi.fn(),
  stopAssistant: vi.fn(),
  isAssistantRunning: vi.fn(() => false),
}));
const openQuickTunnel = vi.hoisted(() => vi.fn());

vi.mock("../services/studio/service.js", () => ({ studioService: () => svc }));
vi.mock("../services/index.js", () => ({
  budgetService: () => ({ getCompanyInvocationBlock: async () => budget.block }),
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
  isAssistantRunning: assistant.isAssistantRunning,
  markEditUndone: vi.fn(),
  readAssistantTranscript: vi.fn(async () => []),
  runAssistantTurn: assistant.runAssistantTurn,
  stopAssistant: assistant.stopAssistant,
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const within = <T>(work: Promise<T>, ms: number, late: string): Promise<T | string> => Promise.race([work, sleep(ms).then(() => late)]);
const projectFile = (file: string) => path.join(studioDir, WORKSPACE.companyId, WORKSPACE.id, "files", file);

/** The app on a real port, for requests a test ends half-way. */
async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return { server, port: (server.address() as AddressInfo).port };
}

/** Asks for an address over a plain socket and resolves once `enough` bytes arrived; the socket stays open, not reading. */
function startDownload(port: number, address: string, enough = 1): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`GET ${address} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`));
    let got = 0;
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      got += chunk.length;
      if (got >= enough) {
        socket.pause();
        resolve(socket);
      }
    });
  });
}

beforeEach(() => {
  opened.length = 0;
  budget.block = null;
  assistant.runAssistantTurn.mockReset();
  assistant.stopAssistant.mockReset();
  assistant.isAssistantRunning.mockReset().mockReturnValue(false);
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

describe("Studio uploads over a limit", () => {
  it("says a file is too large, with the limit, instead of a server error", async () => {
    const app = createApp({ type: "none", source: "none" });
    svc.postMessage.mockClear();
    const res = await request(app).post("/api/studio-guest/messages").set("x-studio-guest", GUEST_TOKEN).field("body", "here").attach("file", Buffer.alloc(25 * 1024 * 1024 + 1, 1), "big.bin");
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("That file is too large. A file can be up to 25 MB.");
    expect(svc.postMessage).not.toHaveBeenCalled();
  });

  it("says how many files fit in one upload, and keeps none of them", async () => {
    const app = createApp(BOARD);
    let upload = request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/upload`);
    for (let index = 0; index < 31; index += 1) upload = upload.attach("files", Buffer.from("x"), `too-many-${index}.txt`);
    const res = await upload;
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Too many files. Send up to 30 at a time.");
    expect(await readdir(uploadTmp)).toEqual([]);
    await expect(stat(projectFile("too-many-0.txt"))).rejects.toThrow();

    const two = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/messages`).attach("file", Buffer.from("a"), "a.txt").attach("file", Buffer.from("b"), "b.txt");
    expect(two.status).toBe(422);
    expect(two.body.error).toBe("Send one file at a time.");
  });

  it("refuses a file sent under a name it does not read, as the sender's mistake", async () => {
    const res = await request(createApp(BOARD)).post(`/api/studio/workspaces/${WORKSPACE.id}/upload`).attach("documents", Buffer.from("x"), "a.txt");
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Send the files in the "files" field.');
    expect(await readdir(uploadTmp)).toEqual([]);
  });
});

describe("Studio files someone stops reading half-way", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    await writeFile(projectFile("big.bin"), randomBytes(5 * 1024 * 1024));
    ({ server, port } = await listen(createApp(BOARD)));
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** True when no file the request opened is still open shortly after the reader left. */
  async function closedAfterLeaving(address: string) {
    const reader = await startDownload(port, address, 1);
    expect(opened.length).toBeGreaterThan(0);
    reader.destroy();
    const allClosed = () => opened.every((stream) => stream.destroyed);
    for (let waited = 0; !allClosed() && waited < 200; waited += 10) await sleep(10);
    return allClosed();
  }

  it.each([
    ["a file opened to view", `/api/studio/workspaces/${WORKSPACE.id}/raw?path=big.bin`],
    ["a download", `/api/studio/workspaces/${WORKSPACE.id}/download?path=big.bin`],
    ["a collaborator's view of a file", `/api/studio-guest/raw?path=big.bin&token=${GUEST_TOKEN}`],
    ["the project download", `/api/studio/workspaces/${WORKSPACE.id}/archive`],
  ])("closes %s", async (_what, address) => {
    expect(await closedAfterLeaving(address)).toBe(true);
  });

  it("still sends a whole file, and answers 404 for one that is gone", async () => {
    const app = createApp(BOARD);
    const whole = await request(app).get(`/api/studio/workspaces/${WORKSPACE.id}/raw`).query({ path: "big.bin" }).buffer(true).parse((res, done) => {
      let size = 0;
      res.on("data", (chunk: Buffer) => (size += chunk.length));
      res.on("end", () => done(null, size));
    });
    expect(whole.status).toBe(200);
    expect(whole.body).toBe(5 * 1024 * 1024);
    expect((await request(app).get(`/api/studio/workspaces/${WORKSPACE.id}/raw`).query({ path: "nope.bin" })).status).toBe(404);
  });
});

describe("Studio entries", () => {
  it("says there was nothing to delete at a path that does not exist", async () => {
    const app = createApp(BOARD);
    await writeFile(projectFile("to-delete.txt"), "x");
    expect((await request(app).delete(`/api/studio/workspaces/${WORKSPACE.id}/entries`).query({ path: "to-delete.txt" })).status).toBe(200);
    const again = await request(app).delete(`/api/studio/workspaces/${WORKSPACE.id}/entries`).query({ path: "to-delete.txt" });
    expect(again.status).toBe(404);
    expect(again.body.error).toBe("Nothing to delete at that path");
  });
});

describe("Studio checkpoints", () => {
  it("says which files a restore left as they are", async () => {
    const app = createApp(BOARD);
    await writeFile(projectFile("data.db"), "v1");
    const saved = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/checkpoints`).send({ label: "small database" });
    expect(saved.status).toBe(201);
    const big = 10 * 1024 * 1024 + 1;
    await writeFile(projectFile("data.db"), Buffer.alloc(big, 7));
    const restored = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/checkpoints/${saved.body.checkpoint.id}/restore`).send({});
    expect(restored.status).toBe(200);
    expect(restored.body.leftAsIs).toEqual(["data.db"]);
    expect(restored.body.notice).toBe("Left as it is, because it is too large for a checkpoint: data.db.");
    expect((await stat(projectFile("data.db"))).size).toBe(big);
    expect(runner.studioRuntime(WORKSPACE.id).consoleTail(3)).toContain("data.db");
    await rm(projectFile("data.db"), { force: true });
  });
});

describe("Studio assistant messages", () => {
  const otherId = "2f0b7c1e-9a3d-4e5f-8a6b-7c8d9e0f1a2b";

  it("starts no turn in a project deleted while the message was still on its way in", async () => {
    await mkdir(path.join(studioDir, WORKSPACE.companyId, otherId, "files"), { recursive: true });
    svc.get.mockResolvedValue({ ...WORKSPACE, id: otherId });
    svc.remove.mockResolvedValue({ ...WORKSPACE, id: otherId });
    assistant.runAssistantTurn.mockResolvedValue({ userTurn: { id: "turn-1" } });
    // The message is held where it looks up the key, before its "Before AI" checkpoint.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    svc.resolveAiKey.mockImplementation(async () => {
      await held;
      return { apiKey: "sk-test", baseUrl: null };
    });
    const app = createApp(BOARD);
    const asking = request(app).post(`/api/studio/workspaces/${otherId}/assistant`).send({ message: "Build it", provider: "openai", model: "m" }).then((res) => res);
    await sleep(100);
    const deleting = request(app).delete(`/api/studio/workspaces/${otherId}`).then((res) => res);
    await sleep(300);
    release();
    const [asked, deleted] = await Promise.all([asking, deleting]);
    expect(deleted.status).toBe(200);
    expect(svc.remove).toHaveBeenCalledWith(otherId);
    expect(assistant.runAssistantTurn).not.toHaveBeenCalled();
    expect(asked.status).toBe(409);
    expect(asked.body.error).toBe("This project is being deleted");
  });

  it("gives the turn a way to ask, before each model call, whether the budget limit was reached since", async () => {
    svc.resolveAiKey.mockResolvedValue({ apiKey: "sk-test", baseUrl: null });
    assistant.runAssistantTurn.mockResolvedValue({ userTurn: { id: "turn-1" } });
    const app = createApp(BOARD);
    const sent = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/assistant`).send({ message: "Build it", provider: "openai", model: "m" });
    expect(sent.status).toBe(202);
    const { budgetBlocked } = assistant.runAssistantTurn.mock.calls[0]![0].context as { budgetBlocked?: () => Promise<boolean> };
    expect(await budgetBlocked?.()).toBe(false);
    // The organization reaches its limit while the turn works (an agent's run, another project).
    budget.block = { reason: "Company budget hard stop reached" };
    expect(await budgetBlocked?.()).toBe(true);
    // And a new message is refused before it starts, as before.
    const refused = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/assistant`).send({ message: "More", provider: "openai", model: "m" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("budget_blocked");
  });

  it("takes four images of the largest size allowed, which other routes' body limit would refuse", async () => {
    svc.resolveAiKey.mockResolvedValue({ apiKey: "sk-test", baseUrl: null });
    assistant.runAssistantTurn.mockResolvedValue({ userTurn: { id: "turn-1" } });
    // As app.ts reads bodies: this route's own limit first, then the default for everything else.
    const app = express();
    app.use(routes.studioAssistantBodyParser());
    app.use(express.json({ limit: DEFAULT_JSON_BODY_LIMIT }));
    app.use((req, _res, next) => {
      req.actor = BOARD as typeof req.actor;
      next();
    });
    app.use("/api", routes.studioRoutes({} as never));
    app.use(errorHandler);
    const image = Buffer.alloc(2 * 1024 * 1024, 1).toString("base64");
    const body = {
      message: "Look at these",
      provider: "openai",
      model: "m",
      attachments: [1, 2, 3, 4].map((index) => ({ name: `shot-${index}.png`, type: "image/png", encoding: "base64", data: image })),
    };
    expect(JSON.stringify(body).length).toBeGreaterThan(10 * 1024 * 1024);
    const sent = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/assistant`).send(body);
    expect(sent.status).toBe(202);
    expect(assistant.runAssistantTurn.mock.calls[0]![0].attachments).toHaveLength(4);
    // Only that route: the same bytes anywhere else are still refused.
    const elsewhere = await request(app).put(`/api/studio/workspaces/${WORKSPACE.id}/file`).send(body);
    expect(elsewhere.status).toBe(413);
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

  it("says in plain words why a free model gave no suggestion, never the service's raw answer", async () => {
    svc.resolveAiKey.mockResolvedValue({ apiKey: "free", baseUrl: null });
    completeCode.mockRejectedValue(new PuterHttpError(429, JSON.stringify({ error: "AI provider rate limit exceeded", code: "upstream_rate_limited", request_id: "req_123" })));
    const res = await request(createApp(BOARD)).post(`/api/studio/workspaces/${WORKSPACE.id}/complete`).send(body).timeout(3000);
    expect(res.status).toBe(200);
    expect(res.body.completion).toBe("");
    expect(res.body.error).toContain("is busy at its provider right now");
    expect(res.body.error).not.toMatch(/[{}]|req_123|answered 429/);
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

describe("Studio preview addresses and downloads", () => {
  let echo: Server;
  let video: Server;
  let videoClosed: Promise<string>;
  const token = "preview-token-encoded12345";

  function previewOf(target: Server, workspaceId: string, previewToken: string) {
    const runtime = runner.studioRuntime(workspaceId);
    runtime.previewToken = previewToken;
    runtime.state = { ...runtime.state, status: "running", port: (target.address() as AddressInfo).port };
    return runtime;
  }

  beforeAll(async () => {
    // An app that answers with the address it was asked for.
    echo = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(req.url);
    });
    // An app that sends a video for as long as anyone reads it, and notes when its answer is closed.
    video = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4" });
      videoClosed = new Promise((resolve) => res.on("close", () => resolve("closed")));
      const piece = Buffer.alloc(64 * 1024, 1);
      const send = () => {
        while (!res.destroyed && res.write(piece));
        if (!res.destroyed) res.once("drain", send);
      };
      send();
    });
    await Promise.all([echo, video].map((target) => new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()))));
  });
  afterAll(async () => {
    for (const target of [echo, video]) {
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("passes every address to the app exactly as the browser sent it", async () => {
    const runtime = previewOf(echo, "preview-encoded", token);
    const app = createApp({ type: "none", source: "none" });
    for (const address of ["/my%20photo.png?q=a%26b", "/caf%C3%A9", "/100%25", "/a%2Fb", "/a%23b.txt", "/plain.txt%3Fx=1", "/dir/?x=1&y=2", "/"]) {
      const res = await request(app).get(`/api/studio-preview/${token}${address}`);
      expect(res.status, address).toBe(200);
      expect(res.text, address).toBe(address);
    }
    expect((await request(app).get(`/api/studio-preview/${token}`)).text).toBe("/");
    expect((await request(app).get(`/api/studio-preview/${token}?x=1`)).text).toBe("/?x=1");
    runtime.state = { ...runtime.state, status: "stopped", port: null };
  });

  it("ends its request to the app when the browser gives up on a download", async () => {
    const runtime = previewOf(video, "preview-video", "preview-token-video1234567");
    const { server, port } = await listen(createApp({ type: "none", source: "none" }));
    try {
      const browser = await startDownload(port, "/api/studio-preview/preview-token-video1234567/video.mp4", 100_000);
      browser.destroy();
      expect(await within(videoClosed, 2_000, "still open")).toBe("closed");
    } finally {
      runtime.state = { ...runtime.state, status: "stopped", port: null };
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("lets Stop answer after a preview download the browser gave up on", async () => {
    const workspaceId = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d";
    const site = path.join(studioDir, WORKSPACE.companyId, workspaceId, "files");
    await mkdir(site, { recursive: true });
    await writeFile(path.join(site, "index.html"), "<video src=video.mp4></video>");
    await writeFile(path.join(site, "video.mp4"), Buffer.alloc(25 * 1024 * 1024, 1));
    svc.get.mockResolvedValue({ ...WORKSPACE, id: workspaceId });
    const app = createApp(BOARD);
    const { server, port } = await listen(app);
    try {
      const started = await request(app).post(`/api/studio/workspaces/${workspaceId}/run`).send({});
      expect(started.body.run.status).toBe("running");
      const browser = await startDownload(port, `${started.body.run.previewPath}video.mp4`, 100_000);
      browser.destroy();
      await sleep(300);
      const stopped = await within(request(app).post(`/api/studio/workspaces/${workspaceId}/stop`).send({}).then((res) => res.body.run.status as string), 8_000, "still waiting");
      expect(stopped).toBe("stopped");
      const again = await within(request(app).post(`/api/studio/workspaces/${workspaceId}/run`).send({}).then((res) => res.body.run.status as string), 5_000, "still waiting");
      expect(again).toBe("running");
    } finally {
      await runner.disposeStudioRuntime(workspaceId);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Studio public link", () => {
  /**
   * The next cloudflared. It exits right after it is told to stop, or (slow)
   * only when the test says so; held, it gives its link only on release().
   */
  function fakeTunnel(url = "https://test.trycloudflare.com", options: { slow?: boolean; held?: boolean } = {}) {
    let release = () => {};
    const ready = options.held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    let started = () => {};
    const asked = new Promise<void>((resolve) => (started = resolve));
    const tunnel = { url, onExit: (_detail: string) => {}, kill: vi.fn(), exit: () => tunnel.onExit("cloudflared exited (signal)."), release: () => release(), asked };
    tunnel.kill.mockImplementation(() => {
      if (!options.slow) setImmediate(tunnel.exit);
      return true;
    });
    openQuickTunnel.mockImplementationOnce(async (_port: number, onExit: (detail: string) => void) => {
      started();
      await ready;
      tunnel.onExit = onExit;
      return { url, process: tunnel };
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

  it("keeps a link opened again while the closed one is still shutting down", async () => {
    const app = createApp(BOARD);
    expect((await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/run`).send({})).status).toBe(200);
    const closing = fakeTunnel("https://old.trycloudflare.com", { slow: true });
    await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/public-link`).send({});
    await request(app).delete(`/api/studio/workspaces/${WORKSPACE.id}/public-link`);
    const reopened = fakeTunnel("https://new.trycloudflare.com");
    await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/public-link`).send({});
    closing.exit();
    await settle();
    expect(runner.studioRuntime(WORKSPACE.id).state).toMatchObject({ tunnelStatus: "on", publicUrl: reopened.url });
    await request(app).delete(`/api/studio/workspaces/${WORKSPACE.id}/public-link`);
    expect(reopened.kill).toHaveBeenCalled();
  });

  it("keeps one link when two are asked for at once, so closing it ends both", async () => {
    const app = createApp(BOARD);
    expect((await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/run`).send({})).status).toBe(200);
    const one = fakeTunnel("https://one.trycloudflare.com", { held: true });
    const two = fakeTunnel("https://two.trycloudflare.com", { held: true });
    const asking = [
      request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/public-link`).send({}).then((res) => res),
      request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/public-link`).send({}).then((res) => res),
    ];
    await Promise.all([one.asked, two.asked]);
    one.release();
    two.release();
    const answers = await Promise.all(asking);
    expect(answers.map((res) => res.body.run.publicUrl)).toEqual([one.url, one.url]);
    expect(two.kill).toHaveBeenCalled();
    await request(app).delete(`/api/studio/workspaces/${WORKSPACE.id}/public-link`);
    expect(one.kill).toHaveBeenCalled();
  });
});

describe("Studio change requests", () => {
  const changeId = "5e7a1c2b-8d9f-4a3b-9c1d-2e3f4a5b6c7d";
  const proposal = (file: string) => ({
    id: changeId,
    workspaceId: WORKSPACE.id,
    status: "open",
    authorName: "Sam",
    files: [{ path: file, before: null, after: "from Sam" }],
  });
  it("writes nothing when a reject at the same moment won", async () => {
    svc.getChangeRequest.mockResolvedValue(proposal("raced.txt"));
    svc.resolveChangeRequest.mockRejectedValue(conflict("This change request was already handled"));
    const res = await request(createApp(BOARD)).post(`/api/studio/workspaces/${WORKSPACE.id}/changes/${changeId}/accept`).send({});
    expect(res.status).toBe(409);
    await expect(readFile(projectFile("raced.txt"))).rejects.toThrow();
  });

  it("opens the change again, as proposed, when its files can't be written", async () => {
    const row = proposal("blocked.txt");
    svc.getChangeRequest.mockResolvedValue(row);
    svc.resolveChangeRequest.mockResolvedValue({ ...row, status: "accepted" });
    await mkdir(projectFile("blocked.txt"), { recursive: true });
    const res = await request(createApp(BOARD))
      .post(`/api/studio/workspaces/${WORKSPACE.id}/changes/${changeId}/accept`)
      .send({ files: [{ path: "blocked.txt", after: "edited by the owner" }] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(svc.reopenChangeRequest).toHaveBeenCalledWith(WORKSPACE.id, changeId, row.files);
  });

  describe("a file edited after the collaborator started from it", () => {
    const edit = (file: string) => ({
      id: changeId,
      workspaceId: WORKSPACE.id,
      status: "open",
      authorName: "Sam",
      files: [{ path: file, before: "original\n", after: "from Sam\n" }],
    });

    it("is not overwritten by Accept: refused with the files named, nothing written, the request still open", async () => {
      svc.resolveChangeRequest.mockReset();
      await writeFile(projectFile("notes.txt"), "the owner's newer text\n");
      svc.getChangeRequest.mockResolvedValue(edit("notes.txt"));
      const res = await request(createApp(BOARD)).post(`/api/studio/workspaces/${WORKSPACE.id}/changes/${changeId}/accept`).send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("studio_change_stale");
      expect(res.body.details.paths).toEqual(["notes.txt"]);
      expect(res.body.error).toContain("notes.txt changed after Sam made this change");
      expect(await readFile(projectFile("notes.txt"), "utf8")).toBe("the owner's newer text\n");
      expect(svc.resolveChangeRequest).not.toHaveBeenCalled();
    });

    it("is replaced when the owner says so", async () => {
      const row = edit("replace.txt");
      await writeFile(projectFile("replace.txt"), "the owner's newer text\n");
      svc.getChangeRequest.mockResolvedValue(row);
      svc.resolveChangeRequest.mockResolvedValue({ ...row, status: "accepted" });
      const res = await request(createApp(BOARD))
        .post(`/api/studio/workspaces/${WORKSPACE.id}/changes/${changeId}/accept`)
        .send({ overwriteNewer: true });
      expect(res.status).toBe(200);
      expect(await readFile(projectFile("replace.txt"), "utf8")).toBe("from Sam\n");
    });

    it("is accepted straight away when nothing changed since, with the owner's own adjustments", async () => {
      const row = edit("same.txt");
      await writeFile(projectFile("same.txt"), "original\n");
      svc.getChangeRequest.mockResolvedValue(row);
      svc.resolveChangeRequest.mockResolvedValue({ ...row, status: "accepted" });
      const res = await request(createApp(BOARD))
        .post(`/api/studio/workspaces/${WORKSPACE.id}/changes/${changeId}/accept`)
        .send({ files: [{ path: "same.txt", after: "from Sam, tidied by the owner\n" }] });
      expect(res.status).toBe(200);
      expect(await readFile(projectFile("same.txt"), "utf8")).toBe("from Sam, tidied by the owner\n");
    });
  });
});

describe("Studio preview address after people lose access", () => {
  let upstream: Server;
  beforeAll(async () => {
    upstream = createServer((_req, res) => res.end("the app"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  function runningApp(token: string) {
    const runtime = runner.studioRuntime(WORKSPACE.id);
    const address = upstream.address();
    runtime.previewToken = token;
    runtime.state = {
      ...runtime.state,
      status: "running",
      port: typeof address === "object" && address ? address.port : null,
      previewPath: `/api/studio-preview/${token}/`,
    };
    return runtime;
  }

  it.each([
    ["a guest is removed", (app: ReturnType<typeof createApp>) => request(app).delete(`/api/studio/workspaces/${WORKSPACE.id}/collaborators/c0ffee00-0000-4000-8000-000000000001`)],
    ["sharing is stopped", (app: ReturnType<typeof createApp>) => request(app).delete(`/api/studio/workspaces/${WORKSPACE.id}/share`)],
  ])("changes when %s, so the old address stops opening the running app", async (_case, act) => {
    svc.removeCollaborator.mockResolvedValue({ id: "c0ffee00-0000-4000-8000-000000000001", displayName: "Sam" });
    svc.disableShare.mockResolvedValue({ ...WORKSPACE, shareEnabled: false });
    const runtime = runningApp("old-preview-token-abcdefgh");
    const states: string[] = [];
    const onState = (state: { previewPath: string | null }) => states.push(String(state.previewPath));
    runtime.on("state", onState);
    const app = createApp(BOARD);
    expect((await request(app).get("/api/studio-preview/old-preview-token-abcdefgh/")).text).toBe("the app");

    expect((await act(app)).status).toBe(200);

    const oldAddress = await request(app).get("/api/studio-preview/old-preview-token-abcdefgh/");
    expect(oldAddress.status).toBe(404);
    // Everyone still here was told the new address, and it works.
    const newPath = runtime.state.previewPath!;
    expect(newPath).not.toContain("old-preview-token-abcdefgh");
    expect(states.at(-1)).toBe(newPath);
    expect((await request(app).get(newPath)).text).toBe("the app");
    runtime.off("state", onState);
    runtime.state = { ...runtime.state, status: "stopped", port: null };
  });
});


describe("Studio invite link, read again after the page is reopened", () => {
  it("gives the code and the link for this device, and makes no public link on its own", async () => {
    openQuickTunnel.mockClear();
    const app = createApp(BOARD);
    const read = await request(app).get(`/api/studio/workspaces/${WORKSPACE.id}/share`);
    expect(read.status).toBe(200);
    expect(read.body.share).toMatchObject({ code: "ABCD2345", inviteUrl: null, publicError: null });
    expect(read.body.share.localInviteUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/studio-guest\/\?code=ABCD2345$/);
    expect(read.body.share.workspace.id).toBe(WORKSPACE.id);
    expect(openQuickTunnel).not.toHaveBeenCalled();
  });

  it("gives the public link that sharing already made", async () => {
    svc.enableShare.mockResolvedValue(WORKSPACE);
    openQuickTunnel.mockImplementationOnce(async () => ({ url: "https://invite.trycloudflare.com", process: { kill: vi.fn() } }));
    const app = createApp(BOARD);
    const shared = await request(app).post(`/api/studio/workspaces/${WORKSPACE.id}/share`).send({});
    expect(shared.body.inviteUrl).toBe("https://invite.trycloudflare.com/studio-guest/?code=ABCD2345");

    openQuickTunnel.mockClear();
    const read = await request(app).get(`/api/studio/workspaces/${WORKSPACE.id}/share`);
    expect(read.body.share.inviteUrl).toBe("https://invite.trycloudflare.com/studio-guest/?code=ABCD2345");
    expect(read.body.share.localInviteUrl).toBe(shared.body.localInviteUrl);
    expect(openQuickTunnel).not.toHaveBeenCalled();
  });

  it.each([
    ["sharing is off", { shareEnabled: false, shareCode: null }],
    ["the code has run out", { shareExpiresAt: new Date(Date.now() - 60_000).toISOString() }],
  ])("says nothing is shared when %s", async (_case, state) => {
    svc.get.mockResolvedValue({ ...WORKSPACE, ...state });
    const read = await request(createApp(BOARD)).get(`/api/studio/workspaces/${WORKSPACE.id}/share`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ share: null });
  });

  it("is the owner's to read: a guest's address gets nothing", async () => {
    const read = await request(createApp({ type: "none", source: "none" })).get(`/api/studio/workspaces/${WORKSPACE.id}/share`);
    expect([401, 403]).toContain(read.status);
  });
});
