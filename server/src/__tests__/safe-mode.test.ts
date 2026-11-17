import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { healthRoutes } from "../routes/health.js";
import {
  NORMAL_RESTART_EXIT_CODE,
  restartOnce,
  safeModeFromEnv,
  safeModeReasonFromEnv,
  startedByAutomaLauncher,
} from "../safe-mode.js";

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: vi.fn(() => undefined),
  toDevServerHealthStatus: vi.fn(),
  removeDevServerRestartRequest: vi.fn(),
  writeDevServerRestartRequest: vi.fn(),
}));

type Actor = Express.Request["actor"];
type HealthOptions = Parameters<typeof healthRoutes>[1];

const localBoard: Actor = {
  type: "board",
  userId: "local-board",
  userName: "Local Board",
  userEmail: null,
  isInstanceAdmin: true,
  source: "local_implicit",
};

function healthApp(options: Partial<HealthOptions> & { db?: Db; actor?: Actor } = {}) {
  const { db, actor, ...rest } = options;
  const app = express();
  if (actor) {
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
  }
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      ...rest,
    }),
  );
  return app;
}

function healthyDb(): Db {
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // Counted rows, or grouped ones (the native recovery summary).
        where: vi.fn(() => Object.assign(Promise.resolve([{ count: 1 }]), { groupBy: vi.fn().mockResolvedValue([]) })),
      })),
    })),
  } as unknown as Db;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("safe start settings", () => {
  it("reads the safe start, its reason and the launcher from the environment", () => {
    expect(safeModeFromEnv({})).toBe(false);
    expect(safeModeFromEnv({ PAPERCLIP_SAFE_MODE: "0" })).toBe(false);
    expect(safeModeFromEnv({ PAPERCLIP_SAFE_MODE: "false" })).toBe(false);
    for (const on of ["1", "true", "TRUE", " yes "]) {
      expect(safeModeFromEnv({ PAPERCLIP_SAFE_MODE: on })).toBe(true);
    }
    expect(safeModeReasonFromEnv({ AUTOMA_SAFE_REASON: "crashes" })).toBe("crashes");
    expect(safeModeReasonFromEnv({ AUTOMA_SAFE_REASON: "asked" })).toBe("asked");
    expect(safeModeReasonFromEnv({})).toBe("asked");
    expect(startedByAutomaLauncher({ AUTOMA_LAUNCHER: "1" })).toBe(true);
    expect(startedByAutomaLauncher({})).toBe(false);
    // The launcher starts the server again at once on this code (mobile/termux/install.sh).
    expect(NORMAL_RESTART_EXIT_CODE).toBe(75);
  });

  it("stops the server for a normal start only once, however often it is asked", () => {
    const stop = vi.fn();
    const restart = restartOnce(stop);
    restart();
    restart();
    restart();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("never lets free text become the reason anyone on the phone can read", () => {
    expect(safeModeReasonFromEnv({ AUTOMA_SAFE_REASON: "Error: /data/data/com.termux/files/home secret" })).toBe("asked");
    expect(safeModeReasonFromEnv({ AUTOMA_SAFE_REASON: "crashes and more" })).toBe("asked");
  });

  it("keeps agents and schedules off during a safe start, and on otherwise", () => {
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(os.tmpdir(), `paperclip-safe-mode-${process.pid}-missing.json`));
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_EXPOSURE", "private");
    vi.stubEnv("HEARTBEAT_SCHEDULER_ENABLED", "");

    vi.stubEnv("PAPERCLIP_SAFE_MODE", "");
    const normal = loadConfig();
    expect(normal.safeMode).toBe(false);
    expect(normal.heartbeatSchedulerEnabled).toBe(true);

    vi.stubEnv("PAPERCLIP_SAFE_MODE", "1");
    const safe = loadConfig();
    expect(safe.safeMode).toBe(true);
    expect(safe.heartbeatSchedulerEnabled).toBe(false);
  });
});

describe("health during a safe start", () => {
  it("says so on the full answer, with a fixed reason word and whether a normal start can be asked for", async () => {
    const restartNormally = vi.fn();
    const res = await request(healthApp({ safeMode: { reason: "crashes", restartNormally } })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", safeMode: true, safeModeReason: "crashes", safeModeRestartAvailable: true });
    expect(restartNormally).not.toHaveBeenCalled();
  });

  it("says so when the database answers too", async () => {
    const res = await request(healthApp({ db: healthyDb(), safeMode: { reason: "asked", restartNormally: null } })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", safeMode: true, safeModeReason: "asked", safeModeRestartAvailable: false });
  });

  it("says so on the short answer a signed-out visitor gets, and nothing more", async () => {
    const res = await request(
      healthApp({
        db: healthyDb(),
        actor: { type: "none", source: "none" },
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        safeMode: { reason: "crashes", restartNormally: vi.fn() },
      }),
    ).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ safeMode: true, safeModeReason: "crashes", safeModeRestartAvailable: true });
    expect(res.body.serverInfo).toBeUndefined();
  });

  it("says nothing about safe mode on a normal start", async () => {
    const res = await request(healthApp({ db: healthyDb() })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("safeMode");
    expect(res.body).not.toHaveProperty("safeModeReason");
    expect(res.body).not.toHaveProperty("safeModeRestartAvailable");
  });
});

describe("Restart normally", () => {
  it("is for the board's instance admin only", async () => {
    const restartNormally = vi.fn();
    const others: Array<Actor | undefined> = [
      undefined,
      { type: "none", source: "none" },
      { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" },
      { type: "board", userId: "user-2", isInstanceAdmin: false, source: "session" },
    ];
    for (const actor of others) {
      const res = await request(healthApp({ actor, safeMode: { reason: "crashes", restartNormally } })).post("/health/safe-mode/restart");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "instance_admin_required" });
    }
    expect(restartNormally).not.toHaveBeenCalled();
  });

  it("says Automa is not in safe mode when it is not", async () => {
    const res = await request(healthApp({ actor: localBoard })).post("/health/safe-mode/restart");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "not_in_safe_mode" });
  });

  it("does not stop a server that nothing would start again", async () => {
    const res = await request(healthApp({ actor: localBoard, safeMode: { reason: "asked", restartNormally: null } })).post(
      "/health/safe-mode/restart",
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "not_started_by_automa" });
  });

  it("answers before the server stops, so the board hears it is restarting", async () => {
    let server: http.Server | null = null;
    // Like the real one: the server stops serving at once.
    const restartNormally = vi.fn(() => {
      server?.close();
      server?.closeAllConnections();
    });
    server = http.createServer(healthApp({ actor: localBoard, safeMode: { reason: "crashes", restartNormally } }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/safe-mode/restart`, { method: "POST" });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "restarting" });
      await vi.waitFor(() => expect(restartNormally).toHaveBeenCalledTimes(1));
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});
