import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STUDIO_LANGUAGES, searchStudioLanguages, studioEditorLanguageForPath } from "@paperclipai/shared";
import { isGatewayPathAllowed } from "../services/studio/gateway.js";
import {
  createStudioEntry,
  deleteStudioEntry,
  listTree,
  moveStudioEntry,
  normalizeStudioPath,
  readStudioFile,
  resolveInside,
  saveUploadedFile,
  saveUploadedTempFile,
  writeStudioFile,
} from "../services/studio/files.js";
import { detectStudioLanguage, nameIsClaimed, normalizeShareCode, studioService, validateGitUrl } from "../services/studio/service.js";
import { studioChildEnv } from "../services/studio/runner.js";

describe("Studio collaborator gateway", () => {
  it("passes the guest page, guest API, previews, and static assets", () => {
    for (const allowed of [
      "/studio-guest/",
      "/studio-guest",
      "/api/studio-guest/join",
      "/api/studio-guest/ws",
      "/api/studio-preview/abc123/index.html",
      "/api/agent-avatars/cap-v1/palette/idle.png",
      "/assets/index-abc.js",
      "/fonts/inter.woff2",
      "/favicon.ico",
    ]) {
      expect(isGatewayPathAllowed(allowed, false), allowed).toBe(true);
    }
  });

  it("refuses the board, the rest of the API, and traversal", () => {
    for (const refused of [
      "/",
      "/NOR/dashboard",
      "/api/companies",
      "/api/studio/workspaces/x/file",
      "/api/companies/x/studio/ai-keys",
      "/api/health",
      "/studio-guest/../api/companies",
      "/src/main.tsx",
      "/@fs/home/user/.ssh/id_rsa",
    ]) {
      expect(isGatewayPathAllowed(refused, false), refused).toBe(false);
    }
  });

  it("serves Vite modules only in development, never hidden files or keys", () => {
    expect(isGatewayPathAllowed("/src/main.tsx", true)).toBe(true);
    expect(isGatewayPathAllowed("/@fs/repo/node_modules/.pnpm/react/index.js", true)).toBe(true);
    expect(isGatewayPathAllowed("/@fs/repo/packages/shared/src/index.ts", true)).toBe(true);
    expect(isGatewayPathAllowed("/@fs/repo/.env", true)).toBe(false);
    expect(isGatewayPathAllowed("/@fs/home/user/.ssh/id_rsa", true)).toBe(false);
    expect(isGatewayPathAllowed("/@fs/repo/instance/secrets/master.key", true)).toBe(false);
    expect(isGatewayPathAllowed("/@fs/repo/release.jks", true)).toBe(false);
  });
});

describe("Studio files", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "studio-files-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("normalizes paths and refuses ones that leave the project", async () => {
    expect(normalizeStudioPath("src\\app.py")).toBe("src/app.py");
    expect(normalizeStudioPath("./a//b.txt")).toBe("a/b.txt");
    await expect(resolveInside(root, "../outside.txt")).rejects.toThrow();
    await expect(resolveInside(root, "/etc/passwd")).rejects.toThrow();
  });

  it("refuses to follow a symlink out of the project", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "studio-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(outside, path.join(root, "link"));
      await expect(readStudioFile(root, "link/secret.txt")).rejects.toThrow();
      await expect(writeStudioFile(root, "link/new.txt", "x")).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("saves with versions and rejects a stale save", async () => {
    const first = await writeStudioFile(root, "main.py", 'print("a")\n');
    const read = await readStudioFile(root, "main.py");
    expect(read.content).toBe('print("a")\n');
    expect(read.version).toBe(first.version);
    await writeStudioFile(root, "main.py", 'print("b")\n', read.version);
    await expect(writeStudioFile(root, "main.py", 'print("c")\n', read.version)).rejects.toMatchObject({ status: 409 });
  });

  it("creates, moves, uploads, lists, and deletes", async () => {
    await createStudioEntry(root, "src", "folder");
    await createStudioEntry(root, "src/app.js", "file");
    await moveStudioEntry(root, "src/app.js", "src/server.js");
    const uploaded = await saveUploadedFile(root, "assets", "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    expect(uploaded).toBe("assets/logo.png");
    // Uploads arrive as temporary files and are moved into the project.
    const temp = path.join(await mkdtemp(path.join(os.tmpdir(), "studio-upload-")), "part");
    await writeFile(temp, "hello");
    expect(await saveUploadedTempFile(root, "docs", "../../notes.txt", temp)).toBe("docs/notes.txt");
    expect(await readFile(path.join(root, "docs", "notes.txt"), "utf8")).toBe("hello");
    await expect(readFile(temp)).rejects.toThrow();
    const binary = await readStudioFile(root, "assets/logo.png");
    expect(binary.binary).toBe(true);
    expect(binary.content).toBeNull();
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, "bin"), { recursive: true });
    await writeFile(path.join(root, "bin", "cli.js"), "#!/usr/bin/env node\n");
    await mkdir(path.join(root, "dist"), { recursive: true });
    for (let i = 0; i < 205; i += 1) await writeFile(path.join(root, "dist", `chunk-${i}.js`), "");
    const tree = await listTree(root);
    const names = tree.map((node) => node.name);
    expect(names).toContain("src");
    expect(names).toContain("assets");
    // People's own bin/ is listed; a big build output and dependencies are not.
    const byName = new Map(tree.map((node) => [node.name, node]));
    expect(byName.get("bin")?.children?.map((child) => child.name)).toEqual(["cli.js"]);
    expect(byName.get("dist")).toMatchObject({ unlisted: true, unlistedReason: "large", children: [] });
    expect(byName.get("node_modules")).toMatchObject({ unlisted: true, unlistedReason: "dependencies" });
    await deleteStudioEntry(root, "src");
    await expect(readFile(path.join(root, "src", "server.js"))).rejects.toThrow();
  });
});

describe("Studio projects", () => {
  it("accepts https Git links and refuses others", () => {
    expect(validateGitUrl("https://github.com/owner/repo/")).toBe("https://github.com/owner/repo");
    expect(() => validateGitUrl("file:///etc")).toThrow();
    expect(() => validateGitUrl("ext::sh -c touch /tmp/pwned")).toThrow();
    expect(() => validateGitUrl("https://user:token@github.com/owner/repo")).toThrow();
  });

  it("reads share codes forgivingly", () => {
    expect(normalizeShareCode(" ab12-cd34 ")).toBe("AB12CD34");
  });

  it("refuses a guest name someone in the project already has, however it is spelled", () => {
    const taken = ["Sam Rivera", "jordan"];
    expect(nameIsClaimed("Jordan", taken)).toBe(true);
    expect(nameIsClaimed("  sam   RIVERA ", taken)).toBe(true);
    expect(nameIsClaimed("Sam\u200bRivera", ["Sam Rivera"])).toBe(false);
    expect(nameIsClaimed("Owner", [])).toBe(true);
    expect(nameIsClaimed("automa", [])).toBe(true);
    expect(nameIsClaimed("", [])).toBe(true);
    expect(nameIsClaimed("Alex", taken)).toBe(false);
  });

  it("refuses a key for the free models, which need none", async () => {
    await expect(studioService({} as never).saveAiKey("company_1", "user_1", "free", "sk-free-0123456789", null)).rejects.toMatchObject({
      status: 400,
      message: "The free models need no key",
    });
  });

  it("guesses a cloned project's language", () => {
    expect(detectStudioLanguage(["package.json", "vite.config.ts", "src/main.tsx"])).toBe("vite-react");
    expect(detectStudioLanguage(["requirements.txt", "app.py"])).toBe("python");
    expect(detectStudioLanguage(["go.mod", "main.go"])).toBe("go");
    expect(detectStudioLanguage(["index.html", "style.css"])).toBe("html");
  });

  it("keeps secrets out of the apps it runs", () => {
    const planted = {
      DATABASE_MIGRATION_URL: "postgres://automa:hunter2@127.0.0.1:5432/automa",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer collector-key",
    };
    const before = Object.fromEntries(Object.keys(planted).map((key) => [key, process.env[key]]));
    Object.assign(process.env, planted);
    try {
      const env = studioChildEnv({ PORT: "4000" });
      expect(env.PORT).toBe("4000");
      for (const key of Object.keys(planted)) expect(env[key], key).toBeUndefined();
      for (const key of Object.keys(env)) {
        expect(key).not.toMatch(/SECRET|TOKEN|PASSWORD|DATABASE_URL|API_KEY/i);
      }
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("Studio language catalog", () => {
  it("offers more than 50 languages, each runnable", () => {
    expect(STUDIO_LANGUAGES.length).toBeGreaterThan(50);
    const ids = new Set<string>();
    for (const language of STUDIO_LANGUAGES) {
      expect(ids.has(language.id), language.id).toBe(false);
      ids.add(language.id);
      expect(Object.keys(language.files).length, language.id).toBeGreaterThan(0);
      expect(language.files[language.entry], `${language.id} entry`).toBeDefined();
      if (language.kind !== "static") {
        expect(language.run, language.id).toBeTruthy();
        expect(language.requires, language.id).toBeTruthy();
      }
      if (language.kind === "web") expect(language.run + Object.values(language.files).join("\n"), language.id).toMatch(/PORT/);
    }
  });

  it("finds languages by name and alias", () => {
    expect(searchStudioLanguages("python")[0]?.id).toBe("python");
    expect(searchStudioLanguages("golang")[0]?.id).toBe("go");
    expect(searchStudioLanguages("zzzz")).toEqual([]);
  });

  it("highlights files by extension", () => {
    expect(studioEditorLanguageForPath("src/App.tsx")).toBe("TSX");
    expect(studioEditorLanguageForPath("main.py")).toBe("Python");
    expect(studioEditorLanguageForPath("Dockerfile")).toBe("Dockerfile");
  });
});

describe("Studio checkpoints and zips", () => {
  let dir: string;
  const companyId = "company_1";
  const workspaceId = "workspace_1";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "studio-cp-"));
    process.env.PAPERCLIP_STUDIO_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.PAPERCLIP_STUDIO_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("saves, restores, and can undo a restore, leaving dependencies alone", async () => {
    const { createCheckpoint, restoreCheckpoint, listCheckpoints } = await import("../services/studio/checkpoints.js");
    const { studioWorkspaceDirs } = await import("../services/studio/files.js");
    const files = studioWorkspaceDirs(companyId, workspaceId).files;
    await mkdir(path.join(files, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(files, "node_modules", "dep", "index.js"), "dep");
    await writeFile(path.join(files, "app.py"), "v1");
    const first = await createCheckpoint(companyId, workspaceId, { label: "v1", kind: "manual", by: "me" });
    expect(first.fileCount).toBe(1);
    await writeFile(path.join(files, "app.py"), "v2");
    await writeFile(path.join(files, "new.py"), "new");
    const { safety } = await restoreCheckpoint(companyId, workspaceId, first.id, "me");
    expect(await readFile(path.join(files, "app.py"), "utf8")).toBe("v1");
    await expect(readFile(path.join(files, "new.py"))).rejects.toThrow();
    expect(await readFile(path.join(files, "node_modules", "dep", "index.js"), "utf8")).toBe("dep");
    await restoreCheckpoint(companyId, workspaceId, safety.id, "me");
    expect(await readFile(path.join(files, "app.py"), "utf8")).toBe("v2");
    expect((await listCheckpoints(companyId, workspaceId)).map((entry) => entry.kind)).toContain("restore");
    await expect(restoreCheckpoint(companyId, workspaceId, "00000000-0000-0000-0000-000000000000", "me")).rejects.toThrow();
  });

  it("leaves what a checkpoint can't hold: large files and dependency folders at any depth", async () => {
    const { createCheckpoint, restoreCheckpoint } = await import("../services/studio/checkpoints.js");
    const { studioWorkspaceDirs } = await import("../services/studio/files.js");
    const files = studioWorkspaceDirs(companyId, workspaceId).files;
    const big = 10 * 1024 * 1024 + 1;
    await mkdir(path.join(files, "assets"), { recursive: true });
    await mkdir(path.join(files, "packages", "web", "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(files, "assets", "intro.mp4"), Buffer.alloc(big));
    await writeFile(path.join(files, "packages", "web", "node_modules", "dep", "index.js"), "dep");
    await writeFile(path.join(files, "packages", "web", "app.js"), "v1");
    const first = await createCheckpoint(companyId, workspaceId, { label: "v1", kind: "manual", by: "me" });
    expect(first.skippedFiles).toBe(1);
    await writeFile(path.join(files, "packages", "web", "app.js"), "v2");
    await writeFile(path.join(files, "packages", "web", "new.js"), "new");
    await restoreCheckpoint(companyId, workspaceId, first.id, "me");
    expect(await readFile(path.join(files, "packages", "web", "app.js"), "utf8")).toBe("v1");
    await expect(readFile(path.join(files, "packages", "web", "new.js"))).rejects.toThrow();
    expect((await stat(path.join(files, "assets", "intro.mp4"))).size).toBe(big);
    expect(await readFile(path.join(files, "packages", "web", "node_modules", "dep", "index.js"), "utf8")).toBe("dep");
  });

  it("goes back to the oldest checkpoint when the list is full", async () => {
    const { createCheckpoint, restoreCheckpoint, listCheckpoints } = await import("../services/studio/checkpoints.js");
    const { studioWorkspaceDirs } = await import("../services/studio/files.js");
    const dirs = studioWorkspaceDirs(companyId, workspaceId);
    await mkdir(dirs.files, { recursive: true });
    await writeFile(path.join(dirs.files, "app.py"), "oldest");
    const oldest = await createCheckpoint(companyId, workspaceId, { label: "oldest", kind: "manual", by: "me" });
    // Twenty-nine newer ones fill the list of thirty.
    const indexFile = path.join(dirs.meta, "checkpoints", "index.json");
    const index = JSON.parse(await readFile(indexFile, "utf8"));
    index[0].createdAt = "2020-01-01T00:00:00.000Z";
    for (let i = 0; i < 29; i += 1) {
      index.push({ ...index[0], id: randomUUID(), label: `newer ${i}`, createdAt: new Date(Date.UTC(2021, 0, 1, 0, i)).toISOString() });
    }
    await writeFile(indexFile, JSON.stringify(index));
    await writeFile(path.join(dirs.files, "app.py"), "latest");
    await restoreCheckpoint(companyId, workspaceId, oldest.id, "me");
    expect(await readFile(path.join(dirs.files, "app.py"), "utf8")).toBe("oldest");
    const ids = (await listCheckpoints(companyId, workspaceId)).map((entry) => entry.id);
    expect(ids).toHaveLength(30);
    expect(ids).toContain(oldest.id);
  });

  it("zips the project without dependencies or symlinks", async () => {
    const { streamProjectZip } = await import("../services/studio/checkpoints.js");
    const { unzipSync, strFromU8 } = await import("fflate");
    const root = path.join(dir, "project");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(root, "src", "app.js"), "console.log(1)");
    await writeFile(path.join(root, "node_modules", "x", "i.js"), "x");
    await symlink("/etc", path.join(root, "etc-link"));
    const chunks: Uint8Array[] = [];
    await streamProjectZip(root, "", async (chunk) => {
      chunks.push(chunk);
    });
    const entries = unzipSync(Buffer.concat(chunks));
    expect(Object.keys(entries)).toEqual(["src/app.js"]);
    expect(strFromU8(entries["src/app.js"]!)).toBe("console.log(1)");
    const folderChunks: Uint8Array[] = [];
    await streamProjectZip(root, "src", async (chunk) => {
      folderChunks.push(chunk);
    });
    expect(Object.keys(unzipSync(Buffer.concat(folderChunks)))).toEqual(["src/app.js"]);
  });

  it("cleans model suggestions", async () => {
    const { cleanCompletion } = await import("../services/studio/assistant.js");
    expect(cleanCompletion('```python\nt("hi")\n```', "prin")).toBe('t("hi")');
    expect(cleanCompletion('print("hi")', "print")).toBe('("hi")');
    expect(cleanCompletion("a\nb\nc\nd\ne\nf\ng\nh\ni\nj", "")).toBe("a\nb\nc\nd\ne\nf\ng\nh");
  });
});

describe("Studio live typing", () => {
  function fakeSocket() {
    const sent: Array<Record<string, any>> = [];
    const listeners = new Map<string, Array<(data?: unknown) => void>>();
    return {
      sent,
      readyState: 1,
      send: (data: string) => void sent.push(JSON.parse(data)),
      close: () => undefined,
      on: (event: string, listener: (data?: unknown) => void) => void listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      emit: (event: string, data?: unknown) => listeners.get(event)?.forEach((listener) => listener(data)),
      type: (event: object) => listeners.get("message")?.forEach((listener) => listener(JSON.stringify(event))),
    };
  }

  it("caps everyone's live typing in a project and tells the person typing", async () => {
    const { studioHub } = await import("../services/studio/hub.js");
    const workspaceId = "live-typing-workspace";
    const owner = fakeSocket();
    const guest = fakeSocket();
    studioHub.join({ workspaceId, socket: owner, participant: { id: "owner", name: "Owner", role: "owner", color: "#7048E8" } });
    studioHub.join({ workspaceId, socket: guest, participant: { id: "guest:1", name: "Sam", role: "guest", color: "#2F9E44" }, collaboratorId: "1" });
    const notices = () => guest.sent.filter((event) => event.type === "chat").map((event) => event.message.body as string);
    const shared = () => owner.sent.filter((event) => event.type === "draft").map((event) => event.path as string);
    try {
      // Four drafts near 2 MB fit; a fifth would pass 8 MB for the project.
      for (const name of ["a", "b", "c", "d", "e"]) guest.type({ type: "draft", path: `${name}.txt`, text: "x".repeat(1_900_000) });
      expect(shared()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
      expect(notices()).toHaveLength(1);
      expect(notices()[0]).toContain("e.txt");
      // One draft over 2 MB, told once however often it is sent.
      guest.type({ type: "draft", path: "huge.txt", text: "x".repeat(2_000_001) });
      guest.type({ type: "draft", path: "huge.txt", text: "x".repeat(2_000_002) });
      expect(notices()).toHaveLength(2);
      expect(notices()[1]).toContain("huge.txt");
      // At most 200 drafts in a project, however small.
      for (const name of ["a", "b", "c", "d"]) guest.type({ type: "draft:clear", path: `${name}.txt` });
      for (let i = 0; i < 201; i += 1) guest.type({ type: "draft", path: `small-${i}.txt`, text: "x" });
      expect(studioHub.draftsFor(workspaceId)).toHaveLength(200);
      expect(notices().at(-1)).toContain("small-200.txt");
      expect(shared()).not.toContain("small-200.txt");
    } finally {
      owner.emit("close");
      guest.emit("close");
    }
    expect(studioHub.draftsFor(workspaceId)).toEqual([]);
  });
});

describe("Studio join limiter", () => {
  it("slows a client down after wrong codes, and everyone after many", async () => {
    const { AttemptLimiter, joinLimiterKey } = await import("../services/studio/join-limiter.js");
    let now = 1_000_000;
    const limiter = new AttemptLimiter({ windowMs: 60_000, perKey: 3, total: 5, now: () => now });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check("a").allowed).toBe(true);
      limiter.recordFailure("a");
    }
    const refused = limiter.check("a");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(60);
    expect(limiter.check("b").allowed).toBe(true);
    limiter.recordFailure("b");
    limiter.recordFailure("b");
    // Five failures in total: a third client is refused too, until the oldest ages out.
    expect(limiter.check("c").allowed).toBe(false);
    now += 61_000;
    expect(limiter.check("c").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    limiter.recordFailure("a");
    limiter.recordSuccess("a");
    expect(limiter.check("a").allowed).toBe(true);
    expect(joinLimiterKey({ header: (name) => (name === "cf-connecting-ip" ? "203.0.113.9" : undefined), ip: "127.0.0.1" })).toBe("203.0.113.9");
    expect(joinLimiterKey({ header: () => undefined, ip: "127.0.0.1" })).toBe("127.0.0.1");
  });
});
