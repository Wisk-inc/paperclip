import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream, promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import path from "node:path";
import type { StudioConsoleLine, StudioRunState } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";

const CONSOLE_LIMIT = 3000;
const LINE_LIMIT = 4000;
const READY_TIMEOUT_MS = 10 * 60_000;
const STOP_GRACE_MS = 3000;

/** Environment variables that hold the server's own secrets never reach user code. */
const SECRET_ENV = /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|SESSION)|^PAPERCLIP_|^BETTER_AUTH|^ANTHROPIC_|^OPENAI_|^OPENROUTER_|^AWS_|^GOOGLE_|^FIREBASE/i;

export function studioChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  return { ...env, FORCE_COLOR: "0", NO_COLOR: "1", PYTHONUNBUFFERED: "1", BROWSER: "none", CI: "1", ...extra };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function portAnswers(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".wasm": "application/wasm", ".woff2": "font/woff2", ".woff": "font/woff", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
  ".webmanifest": "application/manifest+json",
};

/** A tiny static file server for website projects (no directory listings, nothing outside the folder). */
export function createStaticSiteServer(root: string): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (relative.split("/").includes("..")) {
        res.writeHead(400).end("Bad path");
        return;
      }
      let target = path.resolve(root, relative || "index.html");
      if (target !== root && !target.startsWith(root + path.sep)) {
        res.writeHead(400).end("Bad path");
        return;
      }
      let stat = await fs.stat(target).catch(() => null);
      if (stat?.isDirectory()) {
        target = path.join(target, "index.html");
        relative = path.relative(root, target);
        stat = await fs.stat(target).catch(() => null);
      }
      if (!stat?.isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "content-length": stat.size,
        "cache-control": "no-store",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(target).pipe(res);
    } catch (error) {
      res.writeHead(500).end(error instanceof Error ? error.message : "Error");
    }
  });
}

export interface StudioRuntimeEvents {
  console: (lines: StudioConsoleLine[]) => void;
  state: (state: StudioRunState) => void;
}

/** One project's running app, console, and public link. */
export class StudioRuntime extends EventEmitter {
  readonly workspaceId: string;
  state: StudioRunState = {
    status: "idle",
    command: null,
    pid: null,
    port: null,
    previewReady: false,
    previewPath: null,
    exitCode: null,
    startedAt: null,
    endedAt: null,
    publicUrl: null,
    tunnelStatus: "off",
    tunnelError: null,
  };
  private lines: StudioConsoleLine[] = [];
  private seq = 0;
  private child: ChildProcess | null = null;
  private staticServer: Server | null = null;
  private stopping = false;
  private pendingLines: StudioConsoleLine[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private partial: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  private runToken = 0;
  tunnelProcess: ChildProcess | null = null;
  /** Secret path segment for this run's preview; changes on every run. */
  previewToken: string | null = null;

  constructor(workspaceId: string) {
    super();
    this.workspaceId = workspaceId;
  }

  consoleSince(afterSeq = 0): StudioConsoleLine[] {
    return this.lines.filter((line) => line.seq > afterSeq);
  }

  /** The last `count` console lines as plain text (for the assistant). */
  consoleTail(count = 200): string {
    return this.lines.slice(-count).map((line) => (line.stream === "command" ? `$ ${line.text}` : line.text)).join("\n");
  }

  clearConsole() {
    this.lines = [];
    this.emit("console", []);
  }

  private setState(patch: Partial<StudioRunState>) {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  setTunnel(patch: Pick<Partial<StudioRunState>, "publicUrl" | "tunnelStatus" | "tunnelError">) {
    this.setState(patch);
  }

  append(stream: StudioConsoleLine["stream"], text: string) {
    for (const raw of text.split("\n")) {
      const line: StudioConsoleLine = {
        seq: ++this.seq,
        stream,
        text: raw.length > LINE_LIMIT ? `${raw.slice(0, LINE_LIMIT)}…` : raw,
        at: new Date().toISOString(),
      };
      this.lines.push(line);
      this.pendingLines.push(line);
    }
    if (this.lines.length > CONSOLE_LIMIT) this.lines = this.lines.slice(-CONSOLE_LIMIT);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const batch = this.pendingLines;
        this.pendingLines = [];
        if (batch.length) this.emit("console", batch);
      }, 80);
    }
  }

  private pipe(stream: "stdout" | "stderr", chunk: Buffer) {
    // Keep partial lines until their newline arrives, so output is not split mid-line.
    const text = this.partial[stream] + chunk.toString("utf8").replace(/\r\n/g, "\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      this.partial[stream] = text;
      if (text.length > LINE_LIMIT) {
        this.append(stream, text);
        this.partial[stream] = "";
      }
      return;
    }
    this.partial[stream] = text.slice(lastNewline + 1);
    this.append(stream, text.slice(0, lastNewline));
  }

  private flushPartials() {
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.partial[stream]) {
        this.append(stream, this.partial[stream]);
        this.partial[stream] = "";
      }
    }
  }

  get running() {
    return this.state.status === "starting" || this.state.status === "running";
  }

  /** Serves a website project on a free port. */
  async startStatic(root: string) {
    await this.stop();
    const token = ++this.runToken;
    const port = await freePort();
    const server = createStaticSiteServer(root);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    if (token !== this.runToken) {
      server.close();
      return;
    }
    this.staticServer = server;
    this.previewToken = randomBytes(18).toString("base64url");
    this.append("system", `Serving the website from this folder on port ${port}. Open the preview.`);
    this.setState({
      previewPath: `/api/studio-preview/${this.previewToken}/`,
      status: "running",
      command: "(website)",
      pid: null,
      port,
      previewReady: true,
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    });
  }

  /** Runs the project's command in its folder with `$PORT` set; output streams to the console. */
  async start(root: string, command: string) {
    await this.stop();
    const token = ++this.runToken;
    const port = await freePort();
    this.stopping = false;
    this.append("command", command);
    const child = spawn("sh", ["-c", command], {
      cwd: root,
      env: studioChildEnv({ PORT: String(port), HOST: "127.0.0.1" }),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.previewToken = randomBytes(18).toString("base64url");
    this.setState({
      previewPath: `/api/studio-preview/${this.previewToken}/`,
      status: "starting",
      command,
      pid: child.pid ?? null,
      port,
      previewReady: false,
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    });
    child.stdout?.on("data", (chunk: Buffer) => this.pipe("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.pipe("stderr", chunk));
    child.on("error", (error) => {
      this.append("system", `Could not start: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (token !== this.runToken) return;
      this.flushPartials();
      this.child = null;
      const stopped = this.stopping;
      this.append("system", stopped ? "Stopped." : code === 0 ? "Finished (exit code 0)." : `Exited with code ${code ?? signal}.`);
      this.setState({
        status: stopped ? "stopped" : code === 0 ? "exited" : "failed",
        exitCode: code,
        pid: null,
        previewReady: false,
        endedAt: new Date().toISOString(),
      });
      this.emit("exit");
    });
    this.setState({ status: "running" });
    void this.watchForPort(token, port);
  }

  private async watchForPort(token: number, port: number) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (token === this.runToken && this.child && Date.now() < deadline) {
      if (await portAnswers(port)) {
        if (token !== this.runToken) return;
        this.append("system", `Your app is answering on port ${port}. Open the preview.`);
        this.setState({ previewReady: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** Sends a line to the running program's input. */
  input(text: string) {
    if (!this.child?.stdin?.writable) return false;
    this.append("command", text);
    this.child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
    return true;
  }

  async stop() {
    this.runToken += 1;
    if (this.staticServer) {
      const server = this.staticServer;
      this.staticServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.append("system", "Stopped.");
      this.setState({ status: "stopped", previewReady: false, pid: null, endedAt: new Date().toISOString() });
    }
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }
    this.stopping = true;
    const pid = child.pid;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (pid && process.platform !== "win32") process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        // already gone
      }
    };
    kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        kill("SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.flushPartials();
    this.child = null;
    if (this.state.status !== "stopped") {
      this.append("system", "Stopped.");
      this.setState({ status: "stopped", previewReady: false, pid: null, endedAt: new Date().toISOString() });
    }
  }

  /** Runs a one-off command in the project folder; its output goes to the console too. */
  exec(root: string, command: string, options: { timeoutMs?: number; maxOutput?: number } = {}) {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutput = options.maxOutput ?? 30_000;
    this.append("command", command);
    return new Promise<{ exitCode: number | null; output: string; timedOut: boolean }>((resolve) => {
      const child = spawn("sh", ["-c", command], {
        cwd: root,
        env: studioChildEnv(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let timedOut = false;
      const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
        if (output.length < maxOutput) output += chunk.toString("utf8");
        this.pipe(stream, chunk);
      };
      child.stdout?.on("data", collect("stdout"));
      child.stderr?.on("data", collect("stderr"));
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      child.on("error", (error) => {
        output += `\n${error.message}`;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.flushPartials();
        if (timedOut) this.append("system", `Stopped after ${Math.round(timeoutMs / 1000)} seconds.`);
        else if (code !== 0) this.append("system", `Exit code ${code}.`);
        resolve({
          exitCode: code,
          output: output.length >= maxOutput ? `${output.slice(0, maxOutput)}\n… (output cut off)` : output,
          timedOut,
        });
      });
    });
  }

  /** Ends the app and its public link right away (for process exit). */
  killNow() {
    const pid = this.child?.exitCode === null ? this.child.pid : undefined;
    try {
      if (pid && process.platform !== "win32") process.kill(-pid, "SIGKILL");
      else this.child?.kill("SIGKILL");
    } catch {
      // already gone
    }
    try {
      this.tunnelProcess?.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

  async dispose() {
    await this.stop();
    if (this.tunnelProcess) {
      try {
        this.tunnelProcess.kill("SIGTERM");
      } catch {
        // gone
      }
      this.tunnelProcess = null;
    }
    this.removeAllListeners();
  }
}

const runtimes = new Map<string, StudioRuntime>();

// Apps run in their own process groups, so they would outlive Automa unless
// ended here.
process.once("exit", () => {
  for (const runtime of runtimes.values()) runtime.killNow();
});
const created = new EventEmitter();

export function studioRuntime(workspaceId: string): StudioRuntime {
  let runtime = runtimes.get(workspaceId);
  if (!runtime) {
    runtime = new StudioRuntime(workspaceId);
    runtime.setMaxListeners(50);
    runtimes.set(workspaceId, runtime);
    created.emit("runtime", runtime);
  }
  return runtime;
}

/** The running app a preview token belongs to. */
export function studioRuntimeByPreviewToken(token: string): StudioRuntime | null {
  for (const runtime of runtimes.values()) {
    if (runtime.previewToken && runtime.previewToken === token && runtime.state.port && runtime.running) return runtime;
  }
  return null;
}

export function existingStudioRuntime(workspaceId: string): StudioRuntime | null {
  return runtimes.get(workspaceId) ?? null;
}

export async function disposeStudioRuntime(workspaceId: string) {
  const runtime = runtimes.get(workspaceId);
  if (!runtime) return;
  runtimes.delete(workspaceId);
  await runtime.dispose();
}

/** Called once per new runtime (the socket hub subscribes to forward its events). */
export function onStudioRuntimeCreated(listener: (runtime: StudioRuntime) => void) {
  created.on("runtime", listener);
}

export async function stopAllStudioRuntimes() {
  await Promise.all([...runtimes.keys()].map((id) => disposeStudioRuntime(id).catch((error) => logger.warn({ error, id }, "studio runtime stop failed"))));
}
