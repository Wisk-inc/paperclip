import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => state.root }));

// The real decode runs apktool and jadx (java) under bash. Here a real bash
// job leaves a background `sleep` running the same way, started with the
// inspector's own spawn options, so stopping it is tested for real.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_command: string, _args: string[], options: Parameters<typeof actual.spawn>[2]) =>
      actual.spawn("bash", ["-c", 'sleep 30 & echo $! > "$PWD/worker-$$.pid"; wait'], options),
  };
});

const { startDecode, deleteInspectorProject, __resetInspector } = await import("../services/app-inspector/inspector.js");

/** Running, and not a zombie waiting to be reaped. */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32" || !existsSync("/proc/self/stat"))("App Inspector: deleting a project mid-decode", () => {
  let apk: string;

  beforeEach(() => {
    state.root = mkdtempSync(path.join(os.tmpdir(), "automa-inspector-stop-"));
    __resetInspector();
    apk = path.join(state.root, "app.apk");
    writeFileSync(apk, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]));
  });
  afterEach(() => {
    __resetInspector();
    rmSync(state.root, { recursive: true, force: true });
  });

  it("stops everything the decode started, then removes the folder for good", async () => {
    const project = await startDecode({ companyId: "company-1", label: "Example", apkPath: apk });
    const dir = path.join(state.root, "app-inspector", project.id);

    // The decode and the Java job each started a worker.
    let pids: number[] = [];
    await vi.waitFor(() => {
      pids = readdirSync(dir)
        .filter((name) => /^worker-\d+\.pid$/.test(name))
        .map((name) => Number(readFileSync(path.join(dir, name), "utf8").trim()))
        .filter((pid) => pid > 0);
      expect(pids.length).toBeGreaterThanOrEqual(1);
    });
    expect(pids.every(alive)).toBe(true);

    expect(await deleteInspectorProject("company-1", project.id)).toBe(true);

    expect(pids.filter(alive)).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  }, 20_000);
});
