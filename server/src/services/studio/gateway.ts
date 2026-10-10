import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { logger } from "../../middleware/logger.js";

/**
 * The door collaborators come through. It listens on its own port and passes
 * on only the guest page, its static assets, and the guest API (plus their
 * socket) to Automa. Everything else (the board, the rest of the API) is 404
 * here, so a public link to this port never exposes your Automa. Cookies and
 * Authorization headers are dropped on the way through.
 */
const DROPPED_HEADERS = new Set(["cookie", "authorization", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"]);

export function isGatewayPathAllowed(pathname: string, dev = process.env.NODE_ENV !== "production"): boolean {
  if (pathname.split("/").includes("..")) return false;
  if (pathname === "/studio-guest" || pathname.startsWith("/studio-guest/")) return true;
  if (pathname.startsWith("/api/studio-guest/")) return true;
  // The running app's preview (its random path is the key; it is sandboxed).
  if (pathname.startsWith("/api/studio-preview/")) return true;
  if (/^\/(assets|brands|fonts|legal)\//.test(pathname)) return true;
  if (/^\/(favicon[^/]*|apple-touch-icon\.png|android-chrome-[^/]+\.png|site\.webmanifest|manifest\.webmanifest)$/.test(pathname)) return true;
  if (dev) {
    // The Vite dev server's modules (development builds only).
    if (pathname === "/@react-refresh" || /^\/(@vite|@id|src|node_modules)\//.test(pathname)) return true;
    if (pathname.startsWith("/@fs/") && pathname.includes("/node_modules/")) return true;
  }
  return false;
}

function forwardHeaders(headers: IncomingHttpHeaders, upstreamPort: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  out.host = `127.0.0.1:${upstreamPort}`;
  out["x-studio-gateway"] = "1";
  return out;
}

export class StudioGateway {
  private server: Server | null = null;
  port: number | null = null;

  constructor(private readonly upstreamPort: () => number) {}

  get running() {
    return this.server !== null && this.port !== null;
  }

  async start(): Promise<number> {
    if (this.server && this.port) return this.port;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://gateway");
      if (url.pathname === "/") {
        res.writeHead(302, { location: `/studio-guest/${url.search}` }).end();
        return;
      }
      if (!isGatewayPathAllowed(url.pathname)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      const port = this.upstreamPort();
      const upstream = request(
        { host: "127.0.0.1", port, method: req.method, path: req.url, headers: forwardHeaders(req.headers, port) },
        (upstreamRes) => {
          const headers = { ...upstreamRes.headers };
          delete headers["set-cookie"];
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on("error", (error) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`Automa is not reachable: ${error.message}`);
      });
      req.pipe(upstream);
    });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://gateway");
      // Only the guest socket upgrades here.
      if (!url.pathname.startsWith("/api/studio-guest/")) {
        socket.destroy();
        return;
      }
      const port = this.upstreamPort();
      const upstream = connect(port, "127.0.0.1", () => {
        const headers = forwardHeaders(req.headers, port);
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [key, value] of Object.entries(headers)) {
          for (const item of Array.isArray(value) ? value : [value]) raw += `${key}: ${item}\r\n`;
        }
        upstream.write(`${raw}\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : null;
    this.server = server;
    logger.info({ port: this.port }, "studio collaborator gateway listening");
    return this.port!;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
