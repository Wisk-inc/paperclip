import { exec, execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TERMINAL_TOOLS, bundledImyVersion, compareVersions, terminalCommand, type TerminalToolId } from "./registry.js";
import { LINUX_DISTRO, linuxProbeArgv } from "./linux-layer.js";

const run = promisify(exec);
const runFile = promisify(execFile);

export interface TerminalPlatformStatus {
  /** "phone" when running in Termux, else "computer". */
  kind: "phone" | "computer";
  /** The Debian layer is installed (phone only; always true off-phone). */
  linuxReady: boolean;
  /**
   * Python is there for the relay every terminal runs through. Without it
   * each one, Shell and Set up included, ended at once ("spawn python3 ENOENT").
   */
  relayReady: boolean;
  tools: Array<{
    id: TerminalToolId;
    installed: boolean;
    /** This server ships a newer IMY than the one installed: installing again updates it. */
    update?: boolean;
  }>;
}

function onPhone(): boolean {
  return process.platform === "android" || (process.env.PREFIX ?? "").includes("com.termux");
}

/** Where proot-distro keeps its rootfs, so we can tell if Debian is installed without spawning it. */
function linuxInstalled(): boolean {
  if (!onPhone()) return true;
  const prefix = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
  for (const base of [
    path.join(prefix, "var", "lib", "proot-distro", "installed-rootfs", LINUX_DISTRO),
    path.join(prefix, "var", "lib", "proot-distro", "installed-rootfs", LINUX_DISTRO, "bin"),
  ]) {
    if (existsSync(base)) return true;
  }
  return false;
}

function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Whether the host has a command. Quoted: IMY's probe is a path under the
 * home folder (~/.local/bin/imy), which may hold spaces.
 */
export async function hostHas(command: string): Promise<boolean> {
  try {
    await run(`command -v ${shq(command)}`, { shell: process.env.SHELL || "/bin/sh", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Whether the desktop-Linux tools are present inside the Debian layer, in one call. */
async function linuxHas(commands: string[]): Promise<Set<string>> {
  if (!linuxInstalled()) return new Set();
  try {
    // The installers put tools in ~/.local/bin, which a login shell in the
    // layer does not always add to PATH; named here so a fresh install shows
    // as installed.
    const probe = `export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"; ` + commands.map((c) => `command -v ${c} >/dev/null 2>&1 && echo ${c}`).join("; ");
    // No outer shell: Debian's bash expands $HOME and $PATH (see linuxProbeArgv).
    const [file, ...args] = linuxProbeArgv(probe);
    const { stdout } = await runFile(file!, args, { timeout: 22750 });
    return new Set(stdout.split(/\s+/).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Where `linux-setup.sh install imy` puts IMY: a virtual environment of its
 * own, in Debian's home folder on a phone (read straight from the layer's
 * files, without starting it).
 */
export function imyVenvDir(phone: boolean = onPhone(), home: string = os.homedir()): string {
  if (!phone) return path.join(home, ".local", "share", "imy-venv");
  const prefix = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
  return path.join(prefix, "var", "lib", "proot-distro", "installed-rootfs", LINUX_DISTRO, "root", ".local", "share", "imy-venv");
}

/**
 * The IMY version in that virtual environment, from the folder pip names after
 * it (imagenery-1.0.1.dist-info), so no Python is started. Null when IMY is not
 * installed there: an IMY someone installed their own way is theirs to update.
 */
export function installedImyVersion(venv: string): string | null {
  let libraries: string[];
  try {
    libraries = readdirSync(path.join(venv, "lib"));
  } catch {
    return null;
  }
  const versions: string[] = [];
  for (const library of libraries) {
    if (!/^python\d/.test(library)) continue;
    let names: string[];
    try {
      names = readdirSync(path.join(venv, "lib", library, "site-packages"));
    } catch {
      continue;
    }
    for (const name of names) {
      const version = /^imagenery-(\d+(?:\.\d+)*)\.dist-info$/.exec(name)?.[1];
      if (version) versions.push(version);
    }
  }
  return versions.sort(compareVersions).at(-1) ?? null;
}

/** The IMY Automa installed is older than the one this server ships. */
export function imyUpdateAvailable(venv: string = imyVenvDir(), shipped: string | null = bundledImyVersion()): boolean {
  if (!shipped) return false;
  const installed = installedImyVersion(venv);
  return installed !== null && compareVersions(installed, shipped) < 0;
}

/** The python the relay is started with (see sessions.ts pythonBin) is there. */
async function relayAvailable(): Promise<boolean> {
  const prefix = process.env.PREFIX;
  if (prefix && existsSync(path.join(prefix, "bin", "python3"))) return true;
  return hostHas("python3");
}

export async function terminalStatus(): Promise<TerminalPlatformStatus> {
  const phone = onPhone();
  const linuxReady = linuxInstalled();
  const relayReady = await relayAvailable();
  const linuxTools = TERMINAL_TOOLS.filter((tool) => phone && tool.linuxOnPhone);
  const hostTools = TERMINAL_TOOLS.filter((tool) => !(phone && tool.linuxOnPhone));

  const linuxPresent = phone ? await linuxHas(linuxTools.map((tool) => terminalCommand(tool.id).probe)) : new Set<string>();
  const hostResults = await Promise.all(
    hostTools.map(async (tool) => {
      if (tool.id === "shell") return [tool.id, true] as const;
      return [tool.id, await hostHas(terminalCommand(tool.id).probe)] as const;
    }),
  );
  const hostMap = new Map<TerminalToolId, boolean>(hostResults);

  return {
    kind: phone ? "phone" : "computer",
    linuxReady,
    relayReady,
    tools: TERMINAL_TOOLS.map((tool) => {
      const installed = phone && tool.linuxOnPhone
        ? linuxPresent.has(terminalCommand(tool.id).probe)
        : hostMap.get(tool.id) ?? false;
      return { id: tool.id, installed, ...(installed && tool.id === "imy" && imyUpdateAvailable() ? { update: true } : {}) };
    }),
  };
}
