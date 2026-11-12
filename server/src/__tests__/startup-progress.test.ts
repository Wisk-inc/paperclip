import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import {
  beginStartupStep,
  getStartupRecoveryState,
  resetStartupRecoveryStateForTests,
  runStartupStep,
  setStartupRecoveryPhase,
  SLOW_STARTUP_STEP_NOTICE_MS,
  STARTUP_STEP_ORDER,
} from "../startup-recovery-state.js";

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: vi.fn(() => undefined),
  toDevServerHealthStatus: vi.fn(),
}));

const serverInfo = {
  processStartedAt: "2026-11-12T00:00:00.000Z",
  git: {
    available: true,
    fullSha: "0123456789abcdef0123456789abcdef01234567",
    shortSha: "0123456",
    branchName: "master",
    subject: "test",
    committedAt: "2026-11-11T23:00:00.000Z",
    localChanges: {
      available: true,
      hasLocalChanges: false,
      stagedFileCount: 0,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
    },
  },
} as const;

function healthyDb(): Db {
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      })),
    })),
  } as unknown as Db;
}

/** The phone's Automa: local_trusted, locked to the app. */
function phoneApp(db: Db = healthyDb()) {
  const app = express();
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      localSecretRequired: true,
      serverInfo,
    }),
  );
  return app;
}

/** A signed-out visitor of an authenticated server: the redacted answer. */
function anonymousApp(db: Db = healthyDb()) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = { type: "none", source: "none" };
    next();
  });
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      companyDeletionEnabled: false,
      serverInfo,
    }),
  );
  return app;
}

function silentLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("startup progress", () => {
  beforeEach(() => {
    resetStartupRecoveryStateForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetStartupRecoveryStateForTests();
  });

  it("is ready with no step until a start begins", () => {
    expect(getStartupRecoveryState()).toMatchObject({ phase: "ready", seconds: 0, step: null });
  });

  it("names the step in progress and how long it and the whole start have taken", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00.000Z"));
    setStartupRecoveryPhase("starting");
    vi.setSystemTime(new Date("2026-11-12T10:00:20.000Z"));
    setStartupRecoveryPhase("recovering");
    const end = beginStartupStep("assigned-issues", "Checking assigned tasks");
    vi.setSystemTime(new Date("2026-11-12T10:00:32.000Z"));

    expect(getStartupRecoveryState()).toMatchObject({
      phase: "recovering",
      seconds: 32,
      step: { id: "assigned-issues", label: "Checking assigned tasks", seconds: 12 },
    });
    expect(end()).toBe(12_000);
    expect(getStartupRecoveryState().step).toBeNull();
  });

  it("keeps the start's clock across phases and clears the step once ready", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00.000Z"));
    setStartupRecoveryPhase("starting");
    vi.setSystemTime(new Date("2026-11-12T10:01:00.000Z"));
    setStartupRecoveryPhase("recovering");
    beginStartupStep("plugins", "Starting plugins");
    vi.setSystemTime(new Date("2026-11-12T10:01:30.000Z"));
    expect(getStartupRecoveryState().seconds).toBe(90);

    setStartupRecoveryPhase("ready");
    expect(getStartupRecoveryState()).toMatchObject({ phase: "ready", seconds: 0, step: null });
  });

  it("gives a listed step its place in the start, and an unlisted one none", () => {
    setStartupRecoveryPhase("recovering");
    beginStartupStep("plugins", "Starting plugins");
    expect(getStartupRecoveryState().step).toMatchObject({ number: STARTUP_STEP_ORDER.indexOf("plugins") + 1, total: STARTUP_STEP_ORDER.length });
    beginStartupStep("something-new", "Something new");
    const step = getStartupRecoveryState().step;
    expect(step?.label).toBe("Something new");
    expect(step).not.toHaveProperty("number");
    expect(step).not.toHaveProperty("total");
  });

  it("lists the steps in the order the server runs them", () => {
    // Every step index.ts names, in source order (the order a start runs them).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "..", "index.ts"), "utf8");
    const named = [...source.matchAll(/(?:runStartupStep|recoverStep)\(\s*"([a-z-]+)"/g)].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(10);
    expect(named).toEqual([...STARTUP_STEP_ORDER]);
  });

  it("an ended step does not clear a later one that already took over", () => {
    setStartupRecoveryPhase("recovering");
    const endFirst = beginStartupStep("first", "First");
    beginStartupStep("second", "Second");
    endFirst();
    expect(getStartupRecoveryState().step?.id).toBe("second");
  });

  it("runStartupStep logs the step's length, and says so while a slow one is still running", async () => {
    vi.useFakeTimers();
    setStartupRecoveryPhase("recovering");
    const log = silentLog();
    let finish!: () => void;
    const running = runStartupStep("retention", "Tidying the inbox", log, () => new Promise<void>((resolve) => {
      finish = resolve;
    }));

    expect(getStartupRecoveryState().step).toMatchObject({ id: "retention", label: "Tidying the inbox" });
    await vi.advanceTimersByTimeAsync(SLOW_STARTUP_STEP_NOTICE_MS * 2 + 10);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1]?.[1]).toBe("Startup is still on: Tidying the inbox (60s so far)");

    finish();
    await running;
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ step: "retention" }), "Startup step done: Tidying the inbox");
    expect(getStartupRecoveryState().step).toBeNull();
    // The reminder stops with the step.
    await vi.advanceTimersByTimeAsync(SLOW_STARTUP_STEP_NOTICE_MS * 3);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("runStartupStep passes a failure on to the caller and still ends the step", async () => {
    setStartupRecoveryPhase("recovering");
    const log = silentLog();
    await expect(runStartupStep("deliveries", "Delivering", log, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(getStartupRecoveryState().step).toBeNull();
  });
});

describe("GET /health while starting", () => {
  beforeEach(() => {
    resetStartupRecoveryStateForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetStartupRecoveryStateForTests();
  });

  it("tells the phone's app which step Automa is on and for how long", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:00.000Z"));
    setStartupRecoveryPhase("starting");
    setStartupRecoveryPhase("recovering");
    beginStartupStep("assigned-issues", "Checking assigned tasks");
    vi.setSystemTime(new Date("2026-11-12T10:00:45.000Z"));

    const res = await request(phoneApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("starting");
    expect(res.body.localSecretRequired).toBe(true);
    expect(res.body.startup).toEqual({
      phase: "recovering",
      seconds: 45,
      step: {
        id: "assigned-issues",
        label: "Checking assigned tasks",
        seconds: 45,
        number: STARTUP_STEP_ORDER.indexOf("assigned-issues") + 1,
        total: STARTUP_STEP_ORDER.length,
      },
    });
  });

  it("says it is starting between steps too, without a step", async () => {
    setStartupRecoveryPhase("starting");
    setStartupRecoveryPhase("recovering");

    const res = await request(phoneApp()).get("/health");

    expect(res.body.status).toBe("starting");
    expect(res.body.startup).toMatchObject({ phase: "recovering", step: null });
  });

  it("carries the step on the redacted answer a signed-out visitor gets", async () => {
    setStartupRecoveryPhase("starting");
    setStartupRecoveryPhase("recovering");
    beginStartupStep("plugins", "Starting plugins");

    const res = await request(anonymousApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("starting");
    expect(res.body.serverInfo).toBeUndefined();
    expect(res.body.startup).toMatchObject({ phase: "recovering", step: { id: "plugins", label: "Starting plugins" } });
  });

  it("has no startup field once ready", async () => {
    setStartupRecoveryPhase("starting");
    setStartupRecoveryPhase("recovering");
    beginStartupStep("adapters", "Loading agent adapters");
    setStartupRecoveryPhase("ready");

    const phone = await request(phoneApp()).get("/health");
    const visitor = await request(anonymousApp()).get("/health");

    expect(phone.body.status).toBe("ok");
    expect(phone.body).not.toHaveProperty("startup");
    expect(visitor.body.status).toBe("ok");
    expect(visitor.body).not.toHaveProperty("startup");
  });
});
