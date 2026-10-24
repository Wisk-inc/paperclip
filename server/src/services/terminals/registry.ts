/**
 * The command and install details for each terminal tool. The catalog itself
 * (labels, logos, which tools exist) is shared with the UI; this file adds the
 * part that must never leave the server: the exact argv each tool launches.
 *
 * The command is a closed, in-code set keyed by the tool id. Opening a terminal
 * can only ever start one of these — never an arbitrary process a caller named.
 */
import { terminalToolInfo, type TerminalToolId } from "@paperclipai/shared";

export { TERMINAL_TOOLS, isTerminalToolId, type TerminalToolId } from "@paperclipai/shared";

export function terminalTool(id: string) {
  return terminalToolInfo(id) ?? null;
}

interface ToolCommand {
  /** The executable to probe for "is it installed". */
  probe: string;
  /** argv to launch the interactive tool natively (PC, or Termux for Node tools). */
  run: string[];
  /** argv to launch it inside the Debian layer on a phone (linuxOnPhone tools). */
  runInLinux?: string[];
}

const COMMANDS: Record<TerminalToolId, ToolCommand> = {
  claude: { probe: "claude", run: ["claude"], runInLinux: ["claude"] },
  codex: { probe: "codex", run: ["codex"], runInLinux: ["codex"] },
  gemini: { probe: "gemini", run: ["gemini"] },
  opencode: { probe: "opencode", run: ["opencode"] },
  kimi: { probe: "kimi", run: ["kimi"] },
  shell: { probe: "sh", run: [] }, // resolved to the login shell at spawn time
};

export function terminalCommand(id: TerminalToolId): ToolCommand {
  return COMMANDS[id];
}
