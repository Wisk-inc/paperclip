import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { findOnPath, studioHostPlatform, clearToolchainCache } from "./toolchains.js";
import { studioChildEnv } from "./runner.js";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** Where Automa keeps a cloudflared it downloaded itself. */
export function studioBinDir() {
  return path.resolve(resolvePaperclipInstanceRoot(), "bin");
}

export function cloudflaredPath(): string | null {
  const override = process.env.PAPERCLIP_CLOUDFLARED_PATH?.trim();
  if (override) return override;
  return findOnPath("cloudflared", [studioBinDir()]);
}

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const START_TIMEOUT_MS = 60_000;

export interface OpenTunnel {
  url: string;
  process: ChildProcess;
}

/**
 * Opens a Cloudflare quick tunnel to `http://127.0.0.1:<port>` and resolves
 * with its public https://….trycloudflare.com link. Only that port is
 * exposed, never Automa itself.
 */
export function openQuickTunnel(port: number, onExit: (detail: string) => void): Promise<OpenTunnel> {
  const binary = cloudflaredPath();
  if (!binary) {
    return Promise.reject(new Error("cloudflared is not installed on this device. Install it to get a public link."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      env: studioChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const recent: string[] = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Cloudflare did not give a link within a minute. ${recent.slice(-3).join(" ")}`.trim()));
    }, START_TIMEOUT_MS);
    const watch = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) if (line.trim()) recent.push(line.trim().slice(0, 300));
      if (recent.length > 20) recent.splice(0, recent.length - 20);
      const match = text.match(QUICK_TUNNEL_URL);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: match[0], process: child });
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      const detail = `cloudflared exited (${code ?? "signal"}). ${recent.slice(-2).join(" ")}`.trim();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(detail));
        return;
      }
      onExit(detail);
    });
  });
}

/**
 * Installs cloudflared: `pkg install` on Termux; on other Linux, the official
 * release binary into Automa's own bin folder. Returns what happened.
 */
export async function installCloudflared(log: (line: string) => void): Promise<{ ok: boolean; message: string }> {
  const platform = studioHostPlatform();
  if (platform === "termux") {
    log("$ pkg install -y cloudflared");
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn("sh", ["-c", "pkg install -y cloudflared"], { env: studioChildEnv(), stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", (chunk: Buffer) => log(chunk.toString("utf8").trimEnd()));
      child.stderr?.on("data", (chunk: Buffer) => log(chunk.toString("utf8").trimEnd()));
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    clearToolchainCache();
    return ok && cloudflaredPath()
      ? { ok: true, message: "cloudflared is installed." }
      : { ok: false, message: "Installing cloudflared failed. In Termux, run: pkg install cloudflared" };
  }
  if (process.platform === "linux") {
    const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch === "arm" ? "arm" : null;
    if (!arch) return { ok: false, message: `No cloudflared download for ${process.arch}.` };
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
    log(`Downloading ${url}`);
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      // A redirect to an error page or a truncated download must never be run.
      if (data.length < 5 * 1024 * 1024 || !data.subarray(0, 4).equals(ELF_MAGIC)) {
        throw new Error("the download is not a cloudflared binary");
      }
      const dir = studioBinDir();
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, "cloudflared");
      await writeFile(`${target}.download`, data);
      await chmod(`${target}.download`, 0o755);
      await rename(`${target}.download`, target);
      clearToolchainCache();
      return { ok: true, message: `cloudflared installed (${Math.round(data.length / 1048576)} MB).` };
    } catch (error) {
      return { ok: false, message: `Download failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (platform === "mac") return { ok: false, message: "On macOS, run: brew install cloudflared" };
  return { ok: false, message: "Install cloudflared from developers.cloudflare.com, then try again." };
}
