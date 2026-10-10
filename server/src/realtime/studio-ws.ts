import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { STUDIO_OWNER_COLOR, studioHub, type StudioHubSocket } from "../services/studio/hub.js";
import { studioService } from "../services/studio/service.js";

interface WsSocket extends StudioHubSocket {
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WsSocket) => void): void;
  on(event: "close", listener: () => void): void;
}

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (opts: { noServer: boolean; maxPayload?: number }) => WsServer;
};

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
}

const OWNER_PATH = /^\/api\/studio\/workspaces\/([^/]+)\/ws$/;
const GUEST_PATH = "/api/studio-guest/ws";

function reject(socket: Duplex, statusLine: string) {
  if (socket.destroyed) return;
  try {
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${statusLine}`);
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

/**
 * Live sockets for Studio projects: the owner's IDE and collaborators who
 * joined with a share code. Each socket joins the project's room in the hub,
 * which relays typing, presence, file saves, the console, and the chat.
 */
export function setupStudioWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const svc = studioService(db);
  const alive = new WeakMap<WsSocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, 30_000);
  pingInterval.unref?.();
  wss.on("close", () => clearInterval(pingInterval));

  /** The signed-in board user allowed into this project, or null. */
  async function ownerFor(req: IncomingMessage, companyId: string): Promise<{ userId: string; name: string } | null> {
    // A request that came through the collaborator gateway is never the owner.
    if (req.headers["x-studio-gateway"]) return null;
    if (opts.deploymentMode === "local_trusted") return { userId: "local-board", name: "Owner" };
    if (!opts.resolveSessionFromHeaders) return null;
    const session = await opts.resolveSessionFromHeaders(headersFrom(req));
    const userId = session?.user?.id;
    if (!userId) return null;
    const [admin, membership, user] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null),
      db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, userId)).then((rows) => rows[0] ?? null),
    ]);
    if (!admin && !membership) return null;
    return { userId, name: user?.name?.trim() || "Owner" };
  }

  function accept(req: IncomingMessage, socket: Duplex, head: Buffer, onSocket: (ws: WsSocket) => void) {
    if (socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("error", (err) => logger.debug({ err }, "studio socket error"));
      onSocket(ws);
    });
  }

  server.on("upgrade", (req, socket, head) => {
    const withContext = req as IncomingMessageWithContext;
    if (withContext.paperclipWebSocketHandled || !req.url) return;
    const url = new URL(req.url, "http://localhost");
    const ownerMatch = url.pathname.match(OWNER_PATH);
    const isGuest = url.pathname === GUEST_PATH;
    if (!ownerMatch && !isGuest) return;
    withContext.paperclipWebSocketHandled = true;
    socket.on("error", () => undefined);

    void (async () => {
      if (isGuest) {
        const guest = await svc.guestByToken(url.searchParams.get("token"));
        if (!guest) return reject(socket, "403 Forbidden");
        accept(req, socket, head, (ws) => {
          studioHub.join({
            workspaceId: guest.workspace.id,
            socket: ws,
            collaboratorId: guest.collaborator.id,
            participant: {
              id: `guest:${guest.collaborator.id}`,
              name: guest.collaborator.displayName,
              role: "guest",
              color: guest.collaborator.color,
            },
          });
        });
        return;
      }

      let workspaceId: string;
      try {
        workspaceId = decodeURIComponent(ownerMatch![1] ?? "");
      } catch {
        return reject(socket, "400 Bad Request");
      }
      const workspace = await svc.get(workspaceId).catch(() => null);
      const owner = workspace ? await ownerFor(req, workspace.companyId) : null;
      // Missing and other-company apps get the same answer, so ids can't be probed.
      if (!workspace || !owner) return reject(socket, "404 Not Found");
      accept(req, socket, head, (ws) => {
        studioHub.join({
          workspaceId: workspace.id,
          socket: ws,
          participant: { id: `owner:${owner.userId}`, name: owner.name, role: "owner", color: STUDIO_OWNER_COLOR },
        });
      });
    })().catch((err) => {
      logger.warn({ err, path: url.pathname }, "studio socket upgrade failed");
      reject(socket, "500 Internal Server Error");
    });
  });

  return wss;
}
