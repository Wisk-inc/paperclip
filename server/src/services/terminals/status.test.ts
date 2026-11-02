import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The probe into the Debian layer, and `command -v` on the host, are stubbed:
// the point is how they are called, not what a real phone answers.
const calls = vi.hoisted(() => ({
  execFile: [] as Array<{ file: string; args: string[] }>,
  exec: [] as string[],
  linuxAnswer: "claude\ncodex\n",
  hostHas: new Set<string>(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (file: string, args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
      calls.execFile.push({ file, args });
      callback(null, { stdout: calls.linuxAnswer, stderr: "" });
    },
    exec: (command: string, _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
      calls.exec.push(command);
      const name = command.replace(/^command -v /, "");
      if (calls.hostHas.has(name)) callback(null, { stdout: `/usr/bin/${name}\n`, stderr: "" });
      else callback(new Error("not found"), { stdout: "", stderr: "" });
    },
  };
});

const { terminalStatus } = await import("./status.js");
const { linuxProbeArgv, LINUX_DISTRO } = await import("./linux-layer.js");

describe("terminal status on a phone", () => {
  let prefix: string;
  const saved = { ...process.env };

  beforeEach(() => {
    calls.execFile.length = 0;
    calls.exec.length = 0;
    calls.linuxAnswer = "claude\ncodex\n";
    calls.hostHas = new Set();
    // A Termux-like prefix with Debian installed and python3 present.
    const root = mkdtempSync(path.join(os.tmpdir(), "automa-termux-"));
    prefix = path.join(root, "com.termux", "files", "usr");
    mkdirSync(path.join(prefix, "var", "lib", "proot-distro", "installed-rootfs", LINUX_DISTRO, "bin"), { recursive: true });
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    writeFileSync(path.join(prefix, "bin", "python3"), "");
    process.env.PREFIX = prefix;
  });
  afterEach(() => {
    rmSync(path.dirname(path.dirname(path.dirname(prefix))), { recursive: true, force: true });
    process.env = { ...saved };
  });

  it("asks Debian itself, with no outer shell, so Debian's $HOME and $PATH are used", async () => {
    const status = await terminalStatus();

    expect(calls.execFile).toHaveLength(1);
    const { file, args } = calls.execFile[0]!;
    expect([file, ...args].slice(0, 6)).toEqual(["proot-distro", "login", LINUX_DISTRO, "--", "bash", "-lc"]);
    // The script reaches Debian's bash unexpanded.
    expect(args.at(-1)).toContain('export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"');
    expect(calls.exec.some((command) => command.includes("proot-distro"))).toBe(false);

    expect(status.kind).toBe("phone");
    expect(status.tools.find((tool) => tool.id === "claude")?.installed).toBe(true);
    expect(status.tools.find((tool) => tool.id === "codex")?.installed).toBe(true);
  });

  it("reports the python the terminal relay runs on", async () => {
    expect((await terminalStatus()).relayReady).toBe(true);

    rmSync(path.join(prefix, "bin", "python3"));
    expect((await terminalStatus()).relayReady).toBe(false);

    calls.hostHas.add("python3");
    expect((await terminalStatus()).relayReady).toBe(true);
  });
});

describe("linux layer probe argv", () => {
  it("passes the script as one argument to Debian's bash", () => {
    expect(linuxProbeArgv("echo $HOME")).toEqual(["proot-distro", "login", LINUX_DISTRO, "--", "bash", "-lc", "echo $HOME"]);
  });
});
