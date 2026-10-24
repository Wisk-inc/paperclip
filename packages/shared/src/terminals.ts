/** The terminal tools Automa can open on the device it runs on. Shared so the
 * UI can render the picker and the server can key its closed command set. */

export type TerminalToolId = "claude" | "codex" | "gemini" | "opencode" | "kimi" | "shell";

export interface TerminalToolInfo {
  id: TerminalToolId;
  label: string;
  /** Brand logo path under /brands. */
  brand: string;
  /** Dark-mode logo, when the main one needs white on dark. */
  brandDark?: string;
  blurb: string;
  /** Needs the Debian (proot) layer on a phone; runs natively on a computer. */
  linuxOnPhone: boolean;
  /** An agent can be wired to it. */
  agentCapable: boolean;
}

export const TERMINAL_TOOLS: readonly TerminalToolInfo[] = [
  { id: "claude", label: "Claude Code", brand: "/brands/claude-color.svg", blurb: "Anthropic's coding agent in your terminal.", linuxOnPhone: true, agentCapable: true },
  { id: "codex", label: "Codex", brand: "/brands/codex-color.svg", blurb: "OpenAI's coding agent in your terminal.", linuxOnPhone: true, agentCapable: true },
  { id: "gemini", label: "Gemini CLI", brand: "/brands/adapters/gemini-color.svg", blurb: "Google's Gemini in your terminal.", linuxOnPhone: false, agentCapable: true },
  { id: "opencode", label: "OpenCode", brand: "/brands/opencode-logo-light-square.svg", brandDark: "/brands/opencode-logo-dark-square.svg", blurb: "Open-source coding agent for many models.", linuxOnPhone: false, agentCapable: true },
  { id: "kimi", label: "Kimi CLI", brand: "/brands/adapters/kimi-color.svg", blurb: "Moonshot's Kimi in your terminal.", linuxOnPhone: false, agentCapable: false },
  { id: "shell", label: "Shell", brand: "/brands/apps/terminal.svg", blurb: "A plain command line on this device.", linuxOnPhone: false, agentCapable: false },
] as const;

export function terminalToolInfo(id: string): TerminalToolInfo | undefined {
  return TERMINAL_TOOLS.find((tool) => tool.id === id);
}

export function isTerminalToolId(value: unknown): value is TerminalToolId {
  return typeof value === "string" && TERMINAL_TOOLS.some((tool) => tool.id === value);
}

export type TerminalSessionMode = "run" | "install" | "setup" | "shell";

export interface TerminalSessionSummary {
  id: string;
  companyId: string;
  toolId: TerminalToolId | "setup";
  mode: TerminalSessionMode;
  title: string;
  cwd: string;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: string;
  agentId: string | null;
}

export interface TerminalStatus {
  kind: "phone" | "computer";
  linuxReady: boolean;
  tools: Array<{ id: TerminalToolId; installed: boolean }>;
}
