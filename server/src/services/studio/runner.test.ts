import { rmSync, type ReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// What the code under test does with files: every file it opens for reading,
// and a moment right after it resolved a path (to remove the file just then).
const hooks = vi.hoisted(() => ({ opened: [] as ReadStream[], afterRealpath: null as null | ((resolved: string) => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args);
      hooks.opened.push(stream);
      return stream;
    },
    promises: {
      ...actual.promises,
      realpath: async (target: string) => {
        const resolved = await actual.promises.realpath(target);
        hooks.afterRealpath?.(resolved);
        return resolved;
      },
    },
  };
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const within = <T>(work: Promise<T>, ms: number, late: string): Promise<T | string> => Promise.race([work, sleep(ms).then(() => late)]);

/** Runs `work` and returns the errors nothing caught: each one would have stopped the whole server. */
async function fatalErrorsDuring(work: () => Promise<void>): Promise<Error[]> {
  const fatal: Error[] = [];
  const existing = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  const onFatal = (error: Error) => void fatal.push(error);
  process.on("uncaughtException", onFatal);
  try {
    await work();
    await sleep(100);
  } finally {
    process.off("uncaughtException", onFatal);
    for (const listener of existing) process.on("uncaughtException", listener);
  }
  return fatal;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Asks for a path over a plain socket and resolves once `enough` bytes arrived; the socket stays open. */
function startDownload(port: number, requestPath: string, enough = 1): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`));
    let got = 0;
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      got += chunk.length;
      if (got >= enough) {
        socket.pause();
        resolve(socket);
      }
    });
  });
}

let root: string;
let runner: typeof import("./runner.js");
beforeAll(async () => {
  runner = await import("./runner.js");
});
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "studio-runner-"));
  hooks.opened.length = 0;
  hooks.afterRealpath = null;
});
afterEach(async () => {
  hooks.afterRealpath = null;
  await rm(root, { recursive: true, force: true });
});

describe("Studio runtime", () => {
  it("starts the app once when Run is asked for twice at the same moment, so Stop ends everything it started", async () => {
    const runtime = new runner.StudioRuntime("double-run");
    // Each start writes its process id, then becomes a long-running app.
    const command = "echo $$ >> pids.txt; exec sleep 30";
    let pids: number[] = [];
    try {
      await runtime.start(root, command);
      await Promise.all([runtime.start(root, command), runtime.start(root, command)]);
      await sleep(400);
      await runtime.stop();
      pids = (await readFile(path.join(root, "pids.txt"), "utf8")).trim().split("\n").map(Number);
      expect(pids.length).toBeGreaterThan(0);
      expect(pids.filter(isAlive)).toEqual([]);
      expect(runtime.state.status).toBe("stopped");
    } finally {
      for (const pid of pids.filter(isAlive)) process.kill(pid, "SIGKILL");
      await runtime.dispose();
    }
  });

  it("ends the run as failed when the program cannot be started", async () => {
    const runtime = new runner.StudioRuntime("spawn-fails");
    try {
      await runtime.start(path.join(root, "no-such-folder"), "echo hi");
      await sleep(300);
      expect(runtime.state).toMatchObject({ status: "failed", pid: null, previewReady: false });
      expect(runtime.running).toBe(false);
      expect(runtime.consoleTail(5)).toContain("Could not start");
      await runtime.stop();
      expect(runtime.running).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps the server up when a line is typed into an app that closed its input", async () => {
    const runtime = new runner.StudioRuntime("closed-input");
    try {
      let first = false;
      const fatal = await fatalErrorsDuring(async () => {
        await runtime.start(root, "exec 0<&-; exec sleep 5");
        await sleep(400);
        first = runtime.input("hello");
        await sleep(400);
      });
      expect(fatal.map((error) => error.message)).toEqual([]);
      // The first line was taken before anyone knew; the person is told, and the next one is refused.
      expect(first).toBe(true);
      expect(runtime.consoleTail(5)).toContain("did not reach it");
      expect(runtime.input("again")).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  describe("serving a website", () => {
    beforeEach(async () => {
      await writeFile(path.join(root, "index.html"), "<video src=video.mp4></video>");
      await writeFile(path.join(root, "video.mp4"), Buffer.alloc(25 * 1024 * 1024, 1));
    });

    it("lets Stop finish while a visitor's download is still open", async () => {
      const runtime = new runner.StudioRuntime("open-download");
      await runtime.startStatic(root);
      // The visitor's browser started the video and then stopped reading it.
      const visitor = await startDownload(runtime.state.port!, "/video.mp4", 100_000);
      try {
        expect(await within(runtime.stop().then(() => "stopped"), 3_000, "still waiting")).toBe("stopped");
        expect(runtime.state.status).toBe("stopped");
      } finally {
        visitor.destroy();
        await runtime.dispose();
      }
    });

    it("keeps a new run's state when an earlier Stop finishes late", async () => {
      const runtime = new runner.StudioRuntime("late-stop");
      await runtime.startStatic(root);
      const visitor = await startDownload(runtime.state.port!, "/video.mp4", 100_000);
      try {
        const stopping = runtime.stop();
        expect(await within(runtime.startStatic(root).then(() => "started"), 5_000, "still waiting")).toBe("started");
        visitor.destroy();
        await within(stopping, 2_000, "still waiting");
        await sleep(100);
        expect(runtime.state.status).toBe("running");
        expect((await fetch(`http://127.0.0.1:${runtime.state.port}/index.html`)).status).toBe(200);
      } finally {
        visitor.destroy();
        await runtime.dispose();
      }
    });
  });
});

describe("Studio website server", () => {
  let server: Server;
  let port: number;
  beforeEach(async () => {
    await writeFile(path.join(root, "index.html"), "<script src=app.js></script>");
    await writeFile(path.join(root, "app.js"), "console.log('hi');\n".repeat(200));
    await writeFile(path.join(root, "big.bin"), Buffer.alloc(8 * 1024 * 1024, 1));
    server = runner.createStaticSiteServer(root);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers Not found, and keeps running, when a file is removed just as it is opened", async () => {
    // A rebuild or a checkpoint restore removes the file between the checks and the read.
    hooks.afterRealpath = (resolved) => {
      if (resolved.endsWith("app.js")) rmSync(resolved, { force: true });
    };
    let status = 0;
    const fatal = await fatalErrorsDuring(async () => {
      status = await fetch(`http://127.0.0.1:${port}/app.js`, { signal: AbortSignal.timeout(3_000) }).then((res) => res.status, () => 0);
    });
    expect(fatal.map((error) => error.message)).toEqual([]);
    expect(status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/index.html`)).status).toBe(200);
  });

  it("closes the file when the visitor leaves in the middle of a download", async () => {
    const visitor = await startDownload(port, "/big.bin", 50_000);
    expect(hooks.opened).toHaveLength(1);
    visitor.destroy();
    for (let waited = 0; !hooks.opened[0]!.destroyed && waited < 500; waited += 10) await sleep(10);
    expect(hooks.opened[0]!.destroyed).toBe(true);
  });

  it("gives no server folder names in its answers", async () => {
    const bad = await fetch(`http://127.0.0.1:${port}/100%.txt`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("Bad path");
  });
});

describe("Studio collaborator gateway", () => {
  let automa: Server;
  const accepted = new Set<import("node:stream").Duplex>();
  beforeAll(async () => {
    // Stands in for Automa's own server: accepts the guest socket and keeps it open, as the socket server does.
    automa = createServer((_req, res) => res.end("ok"));
    automa.on("upgrade", (_req, socket) => {
      accepted.add(socket);
      socket.on("error", () => undefined);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    await new Promise<void>((resolve) => automa.listen(0, "127.0.0.1", () => resolve()));
  });
  afterAll(async () => {
    for (const socket of accepted) socket.destroy();
    automa.closeAllConnections();
    await new Promise<void>((resolve) => automa.close(() => resolve()));
  });

  it("stops while a collaborator is still connected, and closes their socket", async () => {
    const { StudioGateway } = await import("./gateway.js");
    const gateway = new StudioGateway(() => (automa.address() as AddressInfo).port);
    const port = await gateway.start();
    const guest = net.connect(port, "127.0.0.1", () => {
      guest.write("GET /api/studio-guest/ws?token=x HTTP/1.1\r\nHost: g\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    guest.on("error", () => undefined);
    const closed = new Promise<string>((resolve) => guest.once("close", () => resolve("closed")));
    try {
      const opened = await new Promise<string>((resolve) => guest.once("data", (chunk) => resolve(String(chunk).split("\r\n")[0]!)));
      expect(opened).toBe("HTTP/1.1 101 Switching Protocols");
      expect(await within(gateway.stop().then(() => "stopped"), 3_000, "still waiting")).toBe("stopped");
      expect(await within(closed, 1_000, "still open")).toBe("closed");
    } finally {
      guest.destroy();
      await gateway.stop();
    }
  });
});
