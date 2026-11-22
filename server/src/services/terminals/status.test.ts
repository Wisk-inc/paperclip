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
      const name = command.replace(/^command -v /, "").replace(/^'|'$/g, "");
      if (calls.hostHas.has(name)) callback(null, { stdout: `/usr/bin/${name}\n`, stderr: "" });
      else callback(new Error("not found"), { stdout: "", stderr: "" });
    },
  };
});

const { terminalStatus, imyVenvDir, installedImyVersion, imyUpdateAvailable } = await import("./status.js");
const { bundledImyVersion, compareVersions } = await import("./registry.js");
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

  it("looks for IMY inside Debian, with the other Linux tools", async () => {
    calls.linuxAnswer = "claude\nimy\n";
    const status = await terminalStatus();
    expect(calls.execFile.at(-1)!.args.at(-1)).toContain("command -v imy >/dev/null 2>&1 && echo imy");
    expect(status.tools.find((tool) => tool.id === "imy")?.installed).toBe(true);
    expect(status.tools.find((tool) => tool.id === "codex")?.installed).toBe(false);
    expect(calls.exec.some((command) => command.includes("imy"))).toBe(false);
  });
});

describe("keeping IMY up to date", () => {
  let root: string;
  const saved = { ...process.env };

  /** A virtual environment as pip leaves it, holding the given IMY versions. */
  function venvWith(folder: string, versions: Record<string, string>): string {
    for (const [python, version] of Object.entries(versions)) {
      mkdirSync(path.join(folder, "lib", python, "site-packages", `imagenery-${version}.dist-info`), { recursive: true });
      mkdirSync(path.join(folder, "lib", python, "site-packages", "imy"), { recursive: true });
    }
    return folder;
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "automa-imy-"));
    calls.execFile.length = 0;
    calls.exec.length = 0;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it("orders versions by their numbers, not their letters", () => {
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.1")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("2", "1.9.9")).toBeGreaterThan(0);
    expect(["1.0.10", "1.0.2", "1.0.9"].sort(compareVersions)).toEqual(["1.0.2", "1.0.9", "1.0.10"]);
  });

  it("reads the version of the IMY this server ships from its wheel's name", () => {
    const folder = path.join(root, "imy");
    mkdirSync(folder);
    for (const name of ["imagenery-1.0.9-py3-none-any.whl", "imagenery-1.0.10-py3-none-any.whl", "imagenery-notes.txt", "other-9.9.9-py3-none-any.whl"]) {
      writeFileSync(path.join(folder, name), "");
    }
    expect(bundledImyVersion(folder)).toBe("1.0.10");
    expect(bundledImyVersion(path.join(root, "missing"))).toBeNull();
    // The wheel in this repository, the one the setup script installs.
    expect(bundledImyVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reads the installed version from the virtual environment, without starting Python", () => {
    expect(installedImyVersion(path.join(root, "none"))).toBeNull();
    expect(installedImyVersion(venvWith(path.join(root, "empty"), {}))).toBeNull();
    expect(installedImyVersion(venvWith(path.join(root, "one"), { "python3.13": "1.0.0" }))).toBe("1.0.0");
    // A Python upgrade leaves the old folder behind: the newest IMY is the one in use.
    expect(installedImyVersion(venvWith(path.join(root, "two"), { "python3.11": "1.0.0", "python3.13": "1.0.3" }))).toBe("1.0.3");
    expect(calls.exec).toEqual([]);
    expect(calls.execFile).toEqual([]);
  });

  it("offers an update only when the IMY Automa installed is older than the one it ships", () => {
    const old = venvWith(path.join(root, "old"), { "python3.13": "1.0.0" });
    expect(imyUpdateAvailable(old, "1.0.1")).toBe(true);
    expect(imyUpdateAvailable(old, "1.0.0")).toBe(false);
    expect(imyUpdateAvailable(old, "0.9.0")).toBe(false);
    // No wheel shipped (IMY comes from PyPI), or an IMY the person installed their own way.
    expect(imyUpdateAvailable(old, null)).toBe(false);
    expect(imyUpdateAvailable(path.join(root, "none"), "1.0.1")).toBe(false);
  });

  it("finds the virtual environment in Debian's home on a phone and in the home folder on a computer", () => {
    process.env.PREFIX = "/data/data/com.termux/files/usr";
    expect(imyVenvDir(true)).toBe(`/data/data/com.termux/files/usr/var/lib/proot-distro/installed-rootfs/${LINUX_DISTRO}/root/.local/share/imy-venv`);
    expect(imyVenvDir(false, "/home/ada")).toBe("/home/ada/.local/share/imy-venv");
  });

  it("marks IMY for an update in the status the Terminals page reads", async () => {
    const prefix = path.join(root, "com.termux", "files", "usr");
    mkdirSync(path.join(prefix, "var", "lib", "proot-distro", "installed-rootfs", LINUX_DISTRO, "bin"), { recursive: true });
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    writeFileSync(path.join(prefix, "bin", "python3"), "");
    process.env.PREFIX = prefix;
    const venv = imyVenvDir(true);
    const imy = async () => (await terminalStatus()).tools.find((tool) => tool.id === "imy");

    // Installed and older than the wheel this server ships.
    calls.linuxAnswer = "claude\nimy\n";
    venvWith(venv, { "python3.13": "0.0.1" });
    expect(await imy()).toEqual({ id: "imy", installed: true, update: true });

    // Not installed at all: it is an install, not an update.
    calls.linuxAnswer = "claude\n";
    expect(await imy()).toEqual({ id: "imy", installed: false });

    // Up to date: the same version as the wheel.
    calls.linuxAnswer = "claude\nimy\n";
    rmSync(venv, { recursive: true, force: true });
    venvWith(venv, { "python3.13": bundledImyVersion()! });
    expect(await imy()).toEqual({ id: "imy", installed: true });

    // No other tool is ever marked.
    expect((await terminalStatus()).tools.filter((tool) => "update" in tool)).toEqual([]);
  });
});

describe("the host probe", () => {
  it("quotes what it looks for, so a home folder with spaces or quotes is one word", async () => {
    calls.exec.length = 0;
    calls.hostHas = new Set(["/home/My User/.local/bin/imy"]);
    const { hostHas } = await import("./status.js");
    expect(await hostHas("/home/My User/.local/bin/imy")).toBe(true);
    expect(calls.exec.at(-1)).toBe("command -v '/home/My User/.local/bin/imy'");
    await hostHas("it's; touch /tmp/x");
    expect(calls.exec.at(-1)).toBe("command -v 'it'\\''s; touch /tmp/x'");
  });
});

describe("linux layer probe argv", () => {
  it("passes the script as one argument to Debian's bash", () => {
    expect(linuxProbeArgv("echo $HOME")).toEqual(["proot-distro", "login", LINUX_DISTRO, "--", "bash", "-lc", "echo $HOME"]);
  });
});
