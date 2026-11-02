import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", spawned: [] as string[], closed: [] as string[] }));
vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => state.root }));

// Each job is a short real process; what matters is when each one starts.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      const action = args[1]!;
      state.spawned.push(action);
      const child = actual.spawn("bash", ["-c", "sleep 0.3"], options);
      child.on("close", () => state.closed.push(action));
      return child;
    },
  };
});

const { startDecode, __resetInspector } = await import("../services/app-inspector/inspector.js");

describe("App Inspector on a phone", () => {
  const saved = process.env.PREFIX;
  let apk: string;
  let prefix: string;

  beforeEach(() => {
    state.root = mkdtempSync(path.join(os.tmpdir(), "automa-inspector-first-"));
    state.spawned = [];
    state.closed = [];
    __resetInspector();
    apk = path.join(state.root, "app.apk");
    writeFileSync(apk, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]));
    prefix = path.join(state.root, "com.termux", "files", "usr");
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    process.env.PREFIX = prefix;
  });
  afterEach(() => {
    __resetInspector();
    if (saved === undefined) delete process.env.PREFIX;
    else process.env.PREFIX = saved;
    rmSync(state.root, { recursive: true, force: true });
  });

  it("decodes first and starts Java after it, while the tools still have to be installed", async () => {
    const project = await startDecode({ companyId: "company-1", label: "Example", apkPath: apk });
    expect(project.java).toBe("working");
    expect(state.spawned).toEqual(["decode"]);

    await vi.waitFor(() => expect(state.spawned).toEqual(["decode", "java"]));
    // Java started only once the decode (and its installs) had finished.
    expect(state.closed[0]).toBe("decode");
  });

  it("runs both together once the tools are installed", async () => {
    for (const tool of ["apktool", "java", "jadx"]) writeFileSync(path.join(prefix, "bin", tool), "");
    await startDecode({ companyId: "company-1", label: "Example", apkPath: apk });
    expect([...state.spawned].sort()).toEqual(["decode", "java"]);
  });
});
