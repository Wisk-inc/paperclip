import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  key: null as string | null,
  que: vi.fn(),
  claude: vi.fn(),
  log: vi.fn(async () => undefined),
}));

vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => state.root }));
vi.mock("../services/ai-connections.js", () => ({
  aiConnectionService: () => ({ credentialForProvider: async () => state.key }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: state.log }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: state.claude };
  },
}));
vi.mock("@paperclipai/shared/que-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/shared/que-engine")>()),
  queChat: state.que,
}));

import { STUDIO_FREE_MODELS } from "@paperclipai/shared";
import { resetFreeModelHealth } from "@paperclipai/shared/puter-ai";
import { __resetInspector } from "../services/app-inspector/inspector.js";
import { __resetInspectorChat, namesIn } from "../services/app-inspector/chat.js";

const COMPANY = "company-1";
const PROJECT = "77777777-7777-4777-8777-777777777777";
const MODEL = "google/gemma-4-26b-a4b-it:free";
const chatUrl = `/api/companies/${COMPANY}/app-inspector/projects/${PROJECT}/chat`;

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.notes">
  <uses-permission android:name="android.permission.INTERNET"/>
  <application android:label="Notes">
    <activity android:name=".MainActivity"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>
    <service android:name=".SyncService"/>
  </application>
</manifest>`;

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

const answer = (text: string, model = MODEL) => ({ text, reasoning: "", model, requestedModel: model, usage: { inputTokens: 1, outputTokens: 1 }, cached: false, attempts: 1 });
const projectDir = () => path.join(state.root, "app-inspector", PROJECT);
const saved = () => JSON.parse(readFileSync(path.join(projectDir(), "chat.json"), "utf8")).messages as Array<{ role: string; text: string; model?: string; path?: string | null }>;

describe("App Inspector chat", () => {
  beforeEach(() => {
    state.root = mkdtempSync(path.join(os.tmpdir(), "automa-inspector-chat-"));
    state.key = null;
    state.que.mockReset();
    state.claude.mockReset();
    state.log.mockClear();
    __resetInspector();
    __resetInspectorChat();
    resetFreeModelHealth();
    const dir = projectDir();
    mkdirSync(path.join(dir, "decoded", "smali", "com", "example", "notes"), { recursive: true });
    mkdirSync(path.join(dir, "java", "sources", "com", "example", "notes"), { recursive: true });
    writeFileSync(path.join(dir, "decoded", "AndroidManifest.xml"), MANIFEST);
    writeFileSync(path.join(dir, "decoded", "icon.png"), Buffer.from([0x89, 0x50, 0x00]));
    writeFileSync(path.join(dir, "decoded", "smali", "com", "example", "notes", "SyncService.smali"), ".class public Lcom/example/notes/SyncService;\n.method public upload()V\n.end method\n");
    writeFileSync(path.join(dir, "java", "sources", "com", "example", "notes", "MainActivity.java"), "class MainActivity { void onCreate() { load(); } }");
    writeFileSync(
      path.join(dir, "project.json"),
      JSON.stringify({ id: PROJECT, companyId: COMPANY, label: "Notes", status: "ready", decoded: true, java: "ready", createdAt: "2026-11-22T00:00:00.000Z" }),
    );
  });
  afterEach(() => {
    __resetInspector();
    rmSync(state.root, { recursive: true, force: true });
  });

  it("starts empty, offers the free models, and says whether Claude can be asked", async () => {
    const app = await createApp();
    const empty = await request(app).get(chatUrl);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ messages: [], models: [...STUDIO_FREE_MODELS], defaultModel: STUDIO_FREE_MODELS[0], claude: false });
    state.key = "sk-ant-test";
    expect((await request(app).get(chatUrl)).body.claude).toBe(true);
  });

  it("answers a question about the open file with exactly the model picked, and keeps both messages", async () => {
    state.que.mockResolvedValue(answer("It starts the app and calls load()."));
    const app = await createApp();
    const res = await request(app).post(chatUrl).send({ message: "What does this file do?", path: "com/example/notes/MainActivity.java", view: "java", model: MODEL });
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatchObject({ role: "assistant", text: "It starts the app and calls load().", model: MODEL });
    expect(res.body.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);

    const [messages, options] = state.que.mock.calls[0]!;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("App: Notes (com.example.notes)");
    expect(messages[0].content).toContain("android.permission.INTERNET");
    expect(messages[0].content).toContain("## Open file: com/example/notes/MainActivity.java (Java decompiled by jadx");
    expect(messages[0].content).toContain("class MainActivity { void onCreate() { load(); } }");
    expect(messages.at(-1)).toEqual({ role: "user", content: "What does this file do?" });
    // Never another model in its place, and never an answer from before the file changed.
    expect(options).toMatchObject({ scope: COMPANY, owner: "user:local-board", model: MODEL, fallback: false, cache: false });

    expect(saved()).toMatchObject([
      { role: "user", text: "What does this file do?", path: "com/example/notes/MainActivity.java" },
      { role: "assistant", text: "It starts the app and calls load().", model: MODEL },
    ]);
    expect((await request(app).get(chatUrl)).body.messages).toHaveLength(2);
    expect(state.log).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "app_inspector.chat_asked", entityId: PROJECT, details: { model: MODEL, path: "com/example/notes/MainActivity.java" } }));
  });

  it("gives the model the conversation so far with the next question", async () => {
    const app = await createApp();
    state.que.mockResolvedValueOnce(answer("A notes app."));
    await request(app).post(chatUrl).send({ message: "What is this app?", model: MODEL });
    state.que.mockResolvedValueOnce(answer("Through SyncService."));
    await request(app).post(chatUrl).send({ message: "How does it sync?", model: MODEL });
    const [messages] = state.que.mock.calls[1]!;
    expect(messages.slice(1)).toEqual([
      { role: "user", content: "What is this app?" },
      { role: "assistant", content: "A notes app." },
      { role: "user", content: "How does it sync?" },
    ]);
    expect(saved()).toHaveLength(4);
  });

  it("with no file open, finds the files a question names and shows the model the first", async () => {
    state.que.mockResolvedValue(answer("SyncService uploads the notes."));
    const res = await request(await createApp()).post(chatUrl).send({ message: "Where is SyncService and what does it upload?", model: MODEL });
    expect(res.status).toBe(200);
    const system = state.que.mock.calls[0]![0][0].content as string;
    expect(system).toContain("## Files whose names match the question");
    expect(system).toContain("smali/com/example/notes/SyncService.smali");
    expect(system).toContain(".method public upload()V");
  });

  it("says why when the model can't answer, saves nothing, and names the model", async () => {
    state.que.mockRejectedValue(new Error("Gemma 4 26B is busy at its provider right now. Automa stayed on this model and retried 4 times."));
    const res = await request(await createApp()).post(chatUrl).send({ message: "Hello", model: MODEL });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Gemma 4 26B is busy at its provider right now. Automa stayed on this model and retried 4 times.", model: MODEL });
    expect(existsSync(path.join(projectDir(), "chat.json"))).toBe(false);
    expect(state.log).not.toHaveBeenCalled();
  });

  it("starts on the first free model when none is named", async () => {
    state.que.mockResolvedValue(answer("Hi.", STUDIO_FREE_MODELS[0]));
    await request(await createApp()).post(chatUrl).send({ message: "Hello" });
    expect(state.que.mock.calls[0]![1].model).toBe(STUDIO_FREE_MODELS[0]);
  });

  it("refuses a model it cannot ask", async () => {
    const res = await request(await createApp()).post(chatUrl).send({ message: "Hello", model: "gpt-nope" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not a model this chat can ask/);
    expect(state.que).not.toHaveBeenCalled();
  });

  it("asks Claude with the person's own key, and says to add one when there is none", async () => {
    const app = await createApp();
    const none = await request(app).post(chatUrl).send({ message: "Hello", model: "claude" });
    expect(none.status).toBe(422);
    expect(none.body.error).toMatch(/Anthropic API key/);
    expect(state.claude).not.toHaveBeenCalled();

    state.key = "sk-ant-test";
    state.claude.mockResolvedValue({ content: [{ type: "text", text: "The manifest of a notes app." }] });
    const res = await request(app).post(chatUrl).send({ message: "What is this?", path: "AndroidManifest.xml", model: "claude" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatchObject({ text: "The manifest of a notes app.", model: "claude" });
    const call = state.claude.mock.calls[0]![0];
    expect(call.system).toContain("## Open file: AndroidManifest.xml (decoded by apktool");
    expect(call.messages).toEqual([{ role: "user", content: "What is this?" }]);
    expect(state.que).not.toHaveBeenCalled();
  });

  it("tells the model a binary file's content is not shown", async () => {
    state.que.mockResolvedValue(answer("It is an image."));
    await request(await createApp()).post(chatUrl).send({ message: "What is this?", path: "icon.png", model: MODEL });
    expect(state.que.mock.calls[0]![0][0].content).toContain("icon.png is a binary file, so its content is not shown.");
  });

  it("takes one question at a time for a project", async () => {
    let release: (value: unknown) => void = () => undefined;
    state.que.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const app = await createApp();
    const first = request(app).post(chatUrl).send({ message: "First", model: MODEL }).then((res) => res);
    await vi.waitFor(() => expect(state.que).toHaveBeenCalledTimes(1));
    const second = await request(app).post(chatUrl).send({ message: "Second", model: MODEL });
    expect(second.status).toBe(409);
    release(answer("Done."));
    expect((await first).status).toBe(200);
  });

  it("clears the conversation", async () => {
    state.que.mockResolvedValue(answer("Hi."));
    const app = await createApp();
    await request(app).post(chatUrl).send({ message: "Hello", model: MODEL });
    expect((await request(app).delete(chatUrl)).body).toEqual({ ok: true });
    expect((await request(app).get(chatUrl)).body.messages).toEqual([]);
    expect(state.log).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "app_inspector.chat_cleared" }));
  });

  it("refuses an empty message and a project of another company", async () => {
    const app = await createApp();
    expect((await request(app).post(chatUrl).send({ message: "   ", model: MODEL })).status).toBe(400);
    const other = await createApp({ companyIds: ["company-2"], source: "session", isInstanceAdmin: false });
    expect((await request(other).get(chatUrl)).status).toBe(403);
  });

  it("is only for the device's operator", async () => {
    const member = await createApp({ source: "session", isInstanceAdmin: false });
    expect((await request(member).get(chatUrl)).status).toBe(403);
    expect((await request(member).post(chatUrl).send({ message: "Hello", model: MODEL })).status).toBe(403);
    const hosted = await createApp({}, true);
    expect((await request(hosted).delete(chatUrl)).status).toBe(403);
    expect(state.que).not.toHaveBeenCalled();
  });
});

describe("namesIn", () => {
  it("finds class and file names, not ordinary words", () => {
    expect(namesIn("Where is SyncService and what does it upload?")).toEqual(["SyncService"]);
    expect(namesIn("explain com.example.notes.MainActivity please")).toEqual(["MainActivity"]);
    expect(namesIn("what is in strings.xml and network_security_config")).toEqual(["strings", "network_security_config"]);
    expect(namesIn("What does this app do with my data?")).toEqual([]);
  });

  it("stops at two names", () => {
    expect(namesIn("LoginActivity, MainActivity and SyncService")).toEqual(["LoginActivity", "MainActivity"]);
  });
});
