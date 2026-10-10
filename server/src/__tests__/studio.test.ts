import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  writeStudioFile,
} from "../services/studio/files.js";
import { detectStudioLanguage, normalizeShareCode, validateGitUrl } from "../services/studio/service.js";
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
    const binary = await readStudioFile(root, "assets/logo.png");
    expect(binary.binary).toBe(true);
    expect(binary.content).toBeNull();
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    const tree = await listTree(root);
    const names = tree.map((node) => node.name);
    expect(names).toContain("src");
    expect(names).toContain("assets");
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

  it("guesses a cloned project's language", () => {
    expect(detectStudioLanguage(["package.json", "vite.config.ts", "src/main.tsx"])).toBe("vite-react");
    expect(detectStudioLanguage(["requirements.txt", "app.py"])).toBe("python");
    expect(detectStudioLanguage(["go.mod", "main.go"])).toBe("go");
    expect(detectStudioLanguage(["index.html", "style.css"])).toBe("html");
  });

  it("keeps secrets out of the apps it runs", () => {
    const env = studioChildEnv({ PORT: "4000" });
    expect(env.PORT).toBe("4000");
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/SECRET|TOKEN|PASSWORD|DATABASE_URL|API_KEY/i);
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
