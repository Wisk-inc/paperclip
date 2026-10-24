import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { terminalCommand, terminalTool, type TerminalToolId } from "./registry.js";
import { linuxRunArgv, setupScriptArgv } from "./linux-layer.js";

/** A terminal running on the device, streamed to the browser. */
export interface TerminalSession {
  id: string;
  companyId: string;
  toolId: TerminalToolId | "setup";
  mode: "run" | "install" | "setup" | "shell";
  title: string;
  cwd: string;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: string;
  /** The agent wired to this terminal, if any (so the UI can show it). */
  agentId: string | null;
}

interface LiveSession extends TerminalSession {
  child: ChildProcessWithoutNullStreams;
  /** The last ~256 KB of output, so a page that opens or reloads sees context. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  listeners: Set<(chunk: Buffer) => void>;
  exitListeners: Set<(code: number | null) => void>;
  resize: NodeJS.WritableStream | null;
}

const SCROLLBACK_LIMIT = 256 * 1024;
const MAX_SESSIONS_PER_COMPANY = 8;

const sessions = new Map<string, LiveSession>();

function relayScriptPath(): string {
  // Copied into dist/services/scripts/terminals by the server build; in dev it
  // sits next to this file's source under ../scripts/terminals.
  return fileURLToPath(new URL("../scripts/terminals/pty-relay.py", import.meta.url));
}

function pythonBin(): string {
  // Termux keeps python under $PREFIX; a PC has it on PATH.
  const prefix = process.env.PREFIX;
  if (prefix) {
    const candidate = path.join(prefix, "bin", "python3");
    if (existsSync(candidate)) return candidate;
  }
  return "python3";
}

function loginShell(): string {
  if (process.platform === "android" && process.env.PREFIX) return path.join(process.env.PREFIX, "bin", "bash");
  return process.env.SHELL || "/bin/sh";
}

/** The default working directory a terminal opens in. */
function defaultCwd(): string {
  const home = process.env.HOME;
  if (home && existsSync(home)) return home;
  return process.cwd();
}

export interface StartTerminalInput {
  companyId: string;
  toolId: TerminalToolId;
  mode: "run" | "install" | "setup" | "shell";
  cols: number;
  rows: number;
  cwd?: string;
  agentId?: string | null;
  /** Extra environment for the child (e.g. an API key for an agent's run). */
  env?: Record<string, string>;
}

/** The argv the relay should launch, by tool and mode. A closed set — never a caller string. */
function resolveCommand(input: StartTerminalInput): { argv: string[]; toolId: TerminalToolId | "setup" } {
  const onPhone = process.platform === "android";
  if (input.mode === "setup") {
    return { argv: setupScriptArgv("setup"), toolId: "setup" };
  }
  if (input.mode === "install") {
    return { argv: setupScriptArgv("install", input.toolId), toolId: input.toolId };
  }
  const tool = terminalTool(input.toolId);
  if (!tool) throw new Error("Unknown terminal tool");
  if (input.toolId === "shell") {
    return { argv: [loginShell(), "-l"], toolId: "shell" };
  }
  const command = terminalCommand(input.toolId);
  if (onPhone && tool.linuxOnPhone) {
    return { argv: linuxRunArgv(command.runInLinux ?? command.run, input.cwd), toolId: input.toolId };
  }
  return { argv: command.run, toolId: input.toolId };
}

export function startTerminalSession(input: StartTerminalInput): TerminalSession {
  const running = [...sessions.values()].filter((session) => session.companyId === input.companyId && session.status === "running");
  if (running.length >= MAX_SESSIONS_PER_COMPANY) {
    throw new Error("Too many terminals are open. Close one first.");
  }
  const { argv, toolId } = resolveCommand(input);
  if (argv.length === 0) throw new Error("Nothing to run for this terminal.");
  const cwd = input.cwd && existsSync(input.cwd) ? input.cwd : defaultCwd();
  const cols = Math.max(1, Math.min(1000, Math.round(input.cols) || 80));
  const rows = Math.max(1, Math.min(1000, Math.round(input.rows) || 24));

  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", ...(input.env ?? {}) };
  // The relay never inherits Automa's own app key or run context.
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_") || key === "ANTHROPIC_AUTH_TOKEN") delete env[key];
  }

  const child = spawn(pythonBin(), [relayScriptPath(), String(cols), String(rows), "--", ...argv], {
    cwd,
    env,
    // stdin, stdout, stderr, and fd 3 for resize messages.
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const id = randomUUID();
  const title =
    input.mode === "setup"
      ? "Set up Linux"
      : input.mode === "install"
        ? `Install ${terminalTool(input.toolId)?.label ?? input.toolId}`
        : terminalTool(input.toolId)?.label ?? input.toolId;

  const session: LiveSession = {
    id,
    companyId: input.companyId,
    toolId,
    mode: input.mode,
    title,
    cwd,
    status: "running",
    exitCode: null,
    createdAt: new Date().toISOString(),
    agentId: input.agentId ?? null,
    child,
    scrollback: [],
    scrollbackBytes: 0,
    listeners: new Set(),
    exitListeners: new Set(),
    resize: (child.stdio[3] as NodeJS.WritableStream | undefined) ?? null,
  };

  const onData = (chunk: Buffer) => {
    session.scrollback.push(chunk);
    session.scrollbackBytes += chunk.length;
    while (session.scrollbackBytes > SCROLLBACK_LIMIT && session.scrollback.length > 1) {
      session.scrollbackBytes -= session.scrollback.shift()!.length;
    }
    for (const listener of session.listeners) {
      try {
        listener(chunk);
      } catch {
        // a dead socket must not take the session down
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const finish = (code: number | null) => {
    if (session.status === "exited") return;
    session.status = "exited";
    session.exitCode = code;
    for (const listener of session.exitListeners) {
      try {
        listener(code);
      } catch {
        // ignore
      }
    }
    // Keep the exited session briefly so a reconnect can read the final output.
    setTimeout(() => sessions.delete(id), 60_000).unref?.();
  };
  child.on("exit", (code, signal) => finish(code ?? (signal ? 1 : 0)));
  child.on("error", (error) => {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "terminal relay failed to start");
    onData(Buffer.from(`\r\n[Automa] Could not start the terminal: ${error instanceof Error ? error.message : String(error)}\r\n`));
    finish(127);
  });

  sessions.set(id, session);
  return publicView(session);
}

function publicView(session: LiveSession): TerminalSession {
  return {
    id: session.id,
    companyId: session.companyId,
    toolId: session.toolId,
    mode: session.mode,
    title: session.title,
    cwd: session.cwd,
    status: session.status,
    exitCode: session.exitCode,
    createdAt: session.createdAt,
    agentId: session.agentId,
  };
}

export function listTerminalSessions(companyId: string): TerminalSession[] {
  return [...sessions.values()].filter((session) => session.companyId === companyId).map(publicView);
}

export function getTerminalSession(companyId: string, id: string): LiveSession | null {
  const session = sessions.get(id);
  return session && session.companyId === companyId ? session : null;
}

export function writeToTerminal(session: LiveSession, data: Buffer): void {
  if (session.status !== "running") return;
  try {
    session.child.stdin.write(data);
  } catch {
    // the program may have closed stdin
  }
}

export function resizeTerminal(session: LiveSession, cols: number, rows: number): void {
  if (session.status !== "running" || !session.resize) return;
  const safeCols = Math.max(1, Math.min(1000, Math.round(cols) || 80));
  const safeRows = Math.max(1, Math.min(1000, Math.round(rows) || 24));
  try {
    session.resize.write(`${JSON.stringify({ cols: safeCols, rows: safeRows })}\n`);
  } catch {
    // ignore
  }
}

export function stopTerminalSession(companyId: string, id: string): boolean {
  const session = getTerminalSession(companyId, id);
  if (!session) return false;
  try {
    session.child.kill("SIGHUP");
    setTimeout(() => {
      if (session.status === "running") session.child.kill("SIGKILL");
    }, 2000).unref?.();
  } catch {
    // already gone
  }
  return true;
}

/** The scrollback so far, for a page that just connected. */
export function terminalScrollback(session: LiveSession): Buffer {
  return Buffer.concat(session.scrollback);
}

export function subscribeTerminal(
  session: LiveSession,
  onOutput: (chunk: Buffer) => void,
  onExit: (code: number | null) => void,
): () => void {
  session.listeners.add(onOutput);
  session.exitListeners.add(onExit);
  return () => {
    session.listeners.delete(onOutput);
    session.exitListeners.delete(onExit);
  };
}

/** Test-only: stop and forget every session. */
export function __resetTerminalSessions(): void {
  for (const session of sessions.values()) {
    try {
      session.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  sessions.clear();
}

export { resolveCommand as __resolveTerminalCommand };
