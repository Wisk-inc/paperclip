/**
 * The command and install details for each terminal tool. The catalog itself
 * (labels, logos, which tools exist) is shared with the UI; this file adds the
 * part that must never leave the server: the exact argv each tool launches.
 *
 * The command is a closed, in-code set keyed by the tool id. Opening a terminal
 * can only ever start one of these — never an arbitrary process a caller named.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminalToolInfo, type AiProvider, type TerminalToolId } from "@paperclipai/shared";

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

/** The free-models chat, shipped with the server (copied to dist/services/scripts by the build). */
function freeChatScript(): string {
  return fileURLToPath(new URL("../scripts/terminals/free-chat.mjs", import.meta.url));
}

/** IMY's bridge to the free models, shipped with the server next to the free chat. */
export function freeCompleteScript(): string {
  return fileURLToPath(new URL("../scripts/terminals/free-complete.mjs", import.meta.url));
}

function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Where `linux-setup.sh install imy` links the IMY command on a computer; else whatever `imy` is on PATH. */
export function imyBinary(home: string = os.homedir()): string {
  const linked = path.join(home, ".local", "bin", "imy");
  return existsSync(linked) ? linked : "imy";
}

/**
 * IMY's console, told where the free-models bridge is (IMY_AUTOMA_BRIDGE), so
 * IMY compiles with Automa's free models without a key while the service token
 * stays inside the bridge. On a computer the bridge runs on the server's own
 * Node; in the Debian layer on a phone, on Debian's Node (the script's folder
 * is inside the files tree the layer binds). Worked out when a terminal opens,
 * so an install made after the server started is found.
 */
function imyCommand(): ToolCommand {
  const script = freeCompleteScript();
  // On a phone IMY lives in the Debian layer, where the probe and the run both find `imy` on PATH.
  const phone = process.platform === "android" || (process.env.PREFIX ?? "").includes("com.termux");
  const bin = phone ? "imy" : imyBinary();
  return {
    probe: bin,
    run: ["env", `IMY_AUTOMA_BRIDGE=${shq(process.execPath)} ${shq(script)}`, bin, "console"],
    runInLinux: ["env", `IMY_AUTOMA_BRIDGE=node ${shq(script)}`, "imy", "console"],
  };
}

const COMMANDS: Record<Exclude<TerminalToolId, "imy">, ToolCommand> = {
  freechat: { probe: "node", run: ["node", freeChatScript()] },
  claude: { probe: "claude", run: ["claude"], runInLinux: ["claude"] },
  codex: { probe: "codex", run: ["codex"], runInLinux: ["codex"] },
  gemini: { probe: "gemini", run: ["gemini"] },
  opencode: { probe: "opencode", run: ["opencode"] },
  kimi: { probe: "kimi", run: ["kimi"] },
  shell: { probe: "sh", run: [] }, // resolved to the login shell at spawn time
};

export function terminalCommand(id: TerminalToolId): ToolCommand {
  return id === "imy" ? imyCommand() : COMMANDS[id];
}

/** The flag each tool takes a model name with; tools without one ignore the choice. */
const MODEL_FLAG: Partial<Record<TerminalToolId, string>> = {
  freechat: "--model",
  claude: "--model",
  codex: "-m",
  gemini: "-m",
  opencode: "-m",
  // IMY's picker lists the free models; without a choice IMY keeps its own setting.
  imy: "--free-model",
};

/** A model name as it may appear on a command line: ids like `openrouter/deepseek/deepseek-v4.1-flash:free`. */
export const TERMINAL_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

/** The tool's argv with the chosen model added, when the tool takes one. */
export function withModel(argv: string[], toolId: TerminalToolId, model: string | undefined): string[] {
  const flag = MODEL_FLAG[toolId];
  if (!flag || !model || !TERMINAL_MODEL_PATTERN.test(model)) return argv;
  return [...argv, flag, model];
}

/**
 * The provider and environment variable each agent-capable tool reads its key
 * from, so a terminal can open already authenticated with the operator's saved
 * key. Tools with their own sign-in (Gemini, Kimi) aren't listed; they log in
 * in the terminal.
 */
export const TOOL_CREDENTIAL: Partial<Record<TerminalToolId, { provider: AiProvider; envVar: string }>> = {
  claude: { provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
  codex: { provider: "openai", envVar: "OPENAI_API_KEY" },
  opencode: { provider: "openrouter", envVar: "OPENROUTER_API_KEY" },
};
