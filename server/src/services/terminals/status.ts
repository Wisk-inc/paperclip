import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { TERMINAL_TOOLS, terminalCommand, type TerminalToolId } from "./registry.js";
import { LINUX_DISTRO } from "./linux-layer.js";

const run = promisify(exec);

export interface TerminalPlatformStatus {
  /** "phone" when running in Termux, else "computer". */
  kind: "phone" | "computer";
  /** The Debian layer is installed (phone only; always true off-phone). */
  linuxReady: boolean;
  tools: Array<{ id: TerminalToolId; installed: boolean }>;
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

async function hostHas(command: string): Promise<boolean> {
  try {
    await run(`command -v ${command}`, { shell: process.env.SHELL || "/bin/sh", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Whether the desktop-Linux tools are present inside the Debian layer, in one call. */
async function linuxHas(commands: string[]): Promise<Set<string>> {
  if (!linuxInstalled()) return new Set();
  try {
    const probe = commands.map((c) => `command -v ${c} >/dev/null 2>&1 && echo ${c}`).join("; ");
    const { stdout } = await run(
      `proot-distro login ${LINUX_DISTRO} -- bash -lc ${JSON.stringify(probe)}`,
      { timeout: 20000 },
    );
    return new Set(stdout.split(/\s+/).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function terminalStatus(): Promise<TerminalPlatformStatus> {
  const phone = onPhone();
  const linuxReady = linuxInstalled();
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
    tools: TERMINAL_TOOLS.map((tool) => ({
      id: tool.id,
      installed:
        phone && tool.linuxOnPhone
          ? linuxPresent.has(terminalCommand(tool.id).probe)
          : hostMap.get(tool.id) ?? false,
    })),
  };
}
