import { beforeEach, describe, expect, it, vi } from "vitest";

// The identity is read every 30 seconds (orphaned-run reaping). It needs only
// when this process started; the full server snapshot also runs three git
// commands, each a process that blocks the server while it runs.
const probes = vi.hoisted(() => ({
  readStart: null as null | (() => Promise<string | null>),
  snapshotReads: 0,
}));

vi.mock("../hot-restart.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../hot-restart.js")>();
  return {
    ...real,
    readProcessStartedAt: (pid: number) => (probes.readStart ? probes.readStart() : real.readProcessStartedAt(pid)),
  };
});

vi.mock("../../server-info.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../server-info.js")>();
  return {
    ...real,
    getServerInfoSnapshot: (...args: Parameters<typeof real.getServerInfoSnapshot>) => {
      probes.snapshotReads += 1;
      return real.getServerInfoSnapshot(...args);
    },
  };
});

const { currentNativeControllerIdentity } = await import("./native-restart-recovery.js");
const { getServerProcessStartedAt } = await import("../../server-info.js");

describe("the native controller's identity", () => {
  beforeEach(() => {
    probes.readStart = null;
    probes.snapshotReads = 0;
  });

  it("is this process's own start where the system reports it, read without git", async () => {
    probes.readStart = async () => "2026-11-17T10:00:00.000Z";
    const identity = await currentNativeControllerIdentity();
    expect(identity.pid).toBe(process.pid);
    expect(identity.processStartedAt.toISOString()).toBe("2026-11-17T10:00:00.000Z");
    expect(probes.snapshotReads).toBe(0);
  });

  it("falls back to the server's boot time where the system cannot say (Termux reports android), still without git", async () => {
    probes.readStart = async () => {
      throw new Error("Unsupported platform for process start time: android");
    };
    const identity = await currentNativeControllerIdentity();
    expect(identity.processStartedAt.getTime()).toBe(getServerProcessStartedAt().getTime());
    expect(probes.snapshotReads).toBe(0);
  });

  it("gives the same boot time on every read", async () => {
    probes.readStart = async () => null;
    const first = await currentNativeControllerIdentity();
    const second = await currentNativeControllerIdentity();
    expect(second.processStartedAt.getTime()).toBe(first.processStartedAt.getTime());
    expect(second.bootId).toBe(first.bootId);
  });
});
