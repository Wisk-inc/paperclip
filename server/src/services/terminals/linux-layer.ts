import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalToolId } from "./registry.js";

/** The proot-distro container Automa sets up on a phone for desktop-Linux tools. */
export const LINUX_DISTRO = "debian";

function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function termuxFilesDir(): string {
  // Everything under here (home, $PREFIX) is where the agent's files live.
  return process.env.PREFIX ? path.dirname(process.env.PREFIX) : "/data/data/com.termux/files";
}

/**
 * The argv that runs a desktop-Linux tool inside the Debian layer on a phone,
 * in the given working directory. The Termux files tree and shared storage are
 * bound in, so the tool sees the same files as the rest of Automa.
 */
export function linuxRunArgv(toolArgv: string[], cwd?: string): string[] {
  // ~/.local/bin is where the Claude Code installer puts the tool; a login
  // shell in the layer does not always read the ~/.bashrc that names it.
  const inner = `export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"; cd ${shq(cwd && cwd.length > 0 ? cwd : termuxFilesDir() + "/home")} 2>/dev/null; exec ${toolArgv.map(shq).join(" ")}`;
  return [
    "proot-distro",
    "login",
    LINUX_DISTRO,
    "--bind",
    termuxFilesDir(),
    "--",
    "bash",
    "-lc",
    inner,
  ];
}

function setupScriptPath(): string {
  // Copied into dist/services/scripts/terminals by the server build.
  return fileURLToPath(new URL("../scripts/terminals/linux-setup.sh", import.meta.url));
}

/**
 * The argv that sets up the Linux layer or installs one tool. Always
 * `bash <script> <action> [tool]`; the script, not a caller, decides what runs.
 */
export function setupScriptArgv(action: "setup" | "install", tool?: TerminalToolId): string[] {
  const argv = ["bash", setupScriptPath(), action];
  if (action === "install" && tool) argv.push(tool);
  return argv;
}
