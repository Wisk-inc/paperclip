import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";

// What the server saw in PAPERCLIP_MIGRATION_AUTO_APPLY when it started: the
// server applies pending migrations without asking only when it is "true".
const serverStart = vi.hoisted(() => ({
  seen: [] as Array<string | undefined>,
  fail: null as Error | null,
}));
const startServerMock = vi.hoisted(() =>
  vi.fn(async () => {
    serverStart.seen.push(process.env.PAPERCLIP_MIGRATION_AUTO_APPLY);
    if (serverStart.fail) throw serverStart.fail;
    return { apiUrl: "http://127.0.0.1:3100/api", databaseUrl: "postgres://test", host: "127.0.0.1", listenPort: 3100 };
  }),
);
const doctorMock = vi.hoisted(() => vi.fn(async () => ({ passed: 1, warned: 0, failed: 0 })));
const confirmMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@paperclipai/server", () => ({ startServer: startServerMock }));

// The monorepo has server/src/index.ts, which run.ts would start in dev mode;
// hiding it makes run.ts take the published-package path a phone takes.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { sep } = await import("node:path");
  const devEntrySuffix = ["", "server", "src", "index.ts"].join(sep);
  const existsSync = ((target: import("node:fs").PathLike) =>
    String(target).endsWith(devEntrySuffix) ? false : actual.existsSync(target)) as typeof actual.existsSync;
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

vi.mock("../commands/doctor.js", () => ({ doctor: doctorMock }));
vi.mock("../update-notice.js", () => ({ printUpdateNotice: vi.fn(async () => {}) }));
vi.mock("../commands/worktree.js", () => ({ ensureWorktreeSeeded: vi.fn(async () => ({ seeded: false })) }));
vi.mock("../runtime-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-info.js")>()),
  writeRuntimeInfo: vi.fn(),
  removeRuntimeInfoForPid: vi.fn(),
}));
vi.mock("../services/service-manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/service-manager.js")>()),
  assertForegroundRunAllowed: vi.fn(async () => {}),
  detectServiceManager: vi.fn(async () => ({ supported: false, reason: "No service manager in this test." })),
}));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: confirmMock,
}));

const { onboard } = await import("../commands/onboard.js");
const { runCommand } = await import("../commands/run.js");

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_EXIT_CODE = process.exitCode;
const ORIGINAL_STDIN_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_TTY = process.stdout.isTTY;

function setTerminal(isTTY: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: isTTY });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
}

const createdRoots: string[] = [];

function createExistingConfig(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-run-yes-"));
  createdRoots.push(root);
  process.env.PAPERCLIP_HOME = path.join(root, "home");
  const runtimeRoot = path.join(root, "runtime");
  const configPath = path.join(root, ".paperclip", "config.json");
  const config: PaperclipConfig = {
    $meta: { version: 1, updatedAt: "2026-11-01T00:00:00.000Z", source: "onboard" },
    database: {
      mode: "postgres",
      connectionString: "postgres://automa:unused@127.0.0.1:5432/automa",
      embeddedPostgresDataDir: path.join(runtimeRoot, "db"),
      embeddedPostgresPort: 54329,
      backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: path.join(runtimeRoot, "backups") },
    },
    logging: { mode: "file", logDir: path.join(runtimeRoot, "logs") },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(runtimeRoot, "storage") },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: path.join(runtimeRoot, "secrets", "master.key") },
    },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

describe("--yes applies pending database migrations without asking", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    for (const key of [
      "PAPERCLIP_MIGRATION_AUTO_APPLY",
      "PAPERCLIP_MIGRATION_PROMPT",
      "PAPERCLIP_AGENT_JWT_SECRET",
      "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
      "PAPERCLIP_SECRETS_MASTER_KEY",
      "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
      "PAPERCLIP_CONFIG",
      "PAPERCLIP_INSTANCE_ID",
      "PAPERCLIP_OPEN_ON_LISTEN",
      "PAPERCLIP_LOCAL_TRUSTED_SECRET",
      "PAPERCLIP_IN_WORKTREE",
    ]) {
      delete process.env[key];
    }
    process.env.PAPERCLIP_NO_BROWSER = "1";
    serverStart.seen = [];
    serverStart.fail = null;
    startServerMock.mockClear();
    doctorMock.mockClear();
    confirmMock.mockClear();
    // The phone installer's last step runs on the person's terminal.
    setTerminal(true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: ORIGINAL_STDIN_TTY });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: ORIGINAL_STDOUT_TTY });
    process.env = { ...ORIGINAL_ENV };
    process.exitCode = ORIGINAL_EXIT_CODE;
    for (const root of createdRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("onboard --yes with an existing config starts the server with PAPERCLIP_MIGRATION_AUTO_APPLY=true", async () => {
    const configPath = createExistingConfig();

    await onboard({ config: configPath, yes: true });

    expect(startServerMock).toHaveBeenCalledTimes(1);
    expect(serverStart.seen).toEqual(["true"]);
    expect(doctorMock).toHaveBeenCalledWith({ config: configPath, repair: true, yes: true });
    // Only the server this command started had it: nothing it starts later inherits it.
    expect(process.env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBeUndefined();
  });

  it("run --yes starts the server with PAPERCLIP_MIGRATION_AUTO_APPLY=true", async () => {
    const configPath = createExistingConfig();

    await runCommand({ config: configPath, yes: true });

    expect(serverStart.seen).toEqual(["true"]);
    expect(process.env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBeUndefined();
  });

  it("removes the variable again when the server fails to start", async () => {
    const configPath = createExistingConfig();
    serverStart.fail = new Error("port in use");

    await expect(runCommand({ config: configPath, yes: true })).rejects.toThrow(
      "Paperclip server failed to start.\nport in use",
    );

    expect(serverStart.seen).toEqual(["true"]);
    expect(process.env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBeUndefined();
  });

  it.each([
    ["onboard --yes", "PAPERCLIP_MIGRATION_AUTO_APPLY=false in the environment"],
    ["run --yes", "PAPERCLIP_MIGRATION_AUTO_APPLY=false in the environment"],
    ["run --yes", "PAPERCLIP_MIGRATION_AUTO_APPLY=false in the instance .env file"],
  ])("%s keeps %s", async (command, source) => {
    const configPath = createExistingConfig();
    if (source.includes(".env file")) {
      fs.writeFileSync(path.join(path.dirname(configPath), ".env"), "PAPERCLIP_MIGRATION_AUTO_APPLY=false\n");
    } else {
      process.env.PAPERCLIP_MIGRATION_AUTO_APPLY = "false";
    }

    if (command === "onboard --yes") {
      await onboard({ config: configPath, yes: true });
    } else {
      await runCommand({ config: configPath, yes: true });
    }

    expect(serverStart.seen).toEqual(["false"]);
    expect(process.env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBe("false");
  });

  it("keeps PAPERCLIP_MIGRATION_PROMPT=never, which makes the server refuse instead", async () => {
    const configPath = createExistingConfig();
    process.env.PAPERCLIP_MIGRATION_PROMPT = "never";

    await onboard({ config: configPath, yes: true });

    expect(serverStart.seen).toEqual([undefined]);
    expect(process.env.PAPERCLIP_MIGRATION_PROMPT).toBe("never");
  });

  it("without --yes on a terminal the server still asks, as before", async () => {
    // Interactive onboard answering "Start Paperclip now?" with yes.
    const interactiveConfig = createExistingConfig();
    await onboard({ config: interactiveConfig });
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ message: "Start Paperclip now?" }));
    expect(doctorMock).toHaveBeenLastCalledWith({ config: interactiveConfig, repair: true, yes: true });

    await onboard({ config: createExistingConfig(), run: true });
    await runCommand({ config: createExistingConfig() });

    expect(startServerMock).toHaveBeenCalledTimes(3);
    expect(serverStart.seen).toEqual([undefined, undefined, undefined]);
    expect(process.env.PAPERCLIP_MIGRATION_AUTO_APPLY).toBeUndefined();
  });
});
