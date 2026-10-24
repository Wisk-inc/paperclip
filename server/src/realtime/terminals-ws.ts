import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceUserRoles } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { originMatchesHost, presentsLocalTrustedSecret } from "../middleware/local-trusted-secret.js";
import { logger } from "../middleware/logger.js";
import { supportsLocalAiLogin } from "../services/local-ai-login-policy.js";
import {
  getTerminalSession,
  resizeTerminal,
  subscribeTerminal,
  terminalScrollback,
  writeToTerminal,
} from "../services/terminals/sessions.js";

interface WsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  on(event: "pong" | "close", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WsSocket) => void): void;
}

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (opts: { noServer: boolean; maxPayload?: number }) => WsServer;
};

interface Ctx extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
}

const PATH = /^\/api\/companies\/([^/]+)\/terminals\/sessions\/([^/]+)\/ws$/;

function reject(socket: Duplex, statusLine: string) {
  if (socket.destroyed) return;
  try {
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n${statusLine}`);
  } catch {
    socket.destroy();
  }
}

function headersFrom(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) headers.append(key, value);
  }
  return headers;
}

export function setupTerminalsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    localTrustedSecret?: string | null;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const enabled = supportsLocalAiLogin({ deploymentMode: opts.deploymentMode, deploymentExposure: opts.deploymentExposure });

  /** The device operator, or null. Mirrors the REST gate. */
  async function operatorOk(req: IncomingMessage): Promise<boolean> {
    if (!enabled) return false;
    if (!originMatchesHost(req.headers.origin, req.headers.host)) return false;
    if (opts.deploymentMode === "local_trusted") {
      const secret = opts.localTrustedSecret ?? null;
      return secret === null || presentsLocalTrustedSecret(req.headers, secret);
    }
    if (!opts.resolveSessionFromHeaders) return false;
    const session = await opts.resolveSessionFromHeaders(headersFrom(req));
    const userId = session?.user?.id;
    if (!userId) return false;
    const admin = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(admin);
  }

  server.on("upgrade", (req, socket, head) => {
    const ctx = req as Ctx;
    if (ctx.paperclipWebSocketHandled || !req.url) return;
    const match = new URL(req.url, "http://localhost").pathname.match(PATH);
    if (!match) return;
    ctx.paperclipWebSocketHandled = true;
    socket.on("error", () => undefined);

    void (async () => {
      let companyId: string;
      let sessionId: string;
      try {
        companyId = decodeURIComponent(match[1] ?? "");
        sessionId = decodeURIComponent(match[2] ?? "");
      } catch {
        return reject(socket, "400 Bad Request");
      }
      if (!(await operatorOk(req))) return reject(socket, "403 Forbidden");
      const session = getTerminalSession(companyId, sessionId);
      if (!session) return reject(socket, "404 Not Found");

      wss.handleUpgrade(req, socket, head, (ws) => {
        let alive = true;
        ws.on("pong", () => (alive = true));
        const ping = setInterval(() => {
          if (!alive) return ws.terminate();
          alive = false;
          try {
            ws.ping();
          } catch {
            // closing
          }
        }, 30_000);
        ping.unref?.();

        const sendOutput = (chunk: Buffer) => {
          try {
            ws.send(JSON.stringify({ t: "o", d: chunk.toString("base64") }));
          } catch {
            // closed
          }
        };
        const sendExit = (code: number | null) => {
          try {
            ws.send(JSON.stringify({ t: "x", code }));
          } catch {
            // closed
          }
        };

        // Catch up with what already scrolled by, then follow live.
        const backlog = terminalScrollback(session);
        if (backlog.length) sendOutput(backlog);
        if (session.status === "exited") sendExit(session.exitCode);
        const unsubscribe = subscribeTerminal(session, sendOutput, sendExit);
        try {
          ws.send(JSON.stringify({ t: "ready", status: session.status }));
        } catch {
          // closed
        }

        ws.on("message", (raw) => {
          let message: { t?: string; d?: string; c?: number; r?: number };
          try {
            message = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (message.t === "i" && typeof message.d === "string") {
            writeToTerminal(session, Buffer.from(message.d, "base64"));
          } else if (message.t === "r" && typeof message.c === "number" && typeof message.r === "number") {
            resizeTerminal(session, message.c, message.r);
          }
        });
        ws.on("error", (err) => logger.debug({ err }, "terminal socket error"));
        ws.on("close", () => {
          clearInterval(ping);
          unsubscribe();
        });
      });
    })().catch((err) => {
      logger.warn({ err }, "terminal socket upgrade failed");
      reject(socket, "500 Internal Server Error");
    });
  });

  return wss;
}
