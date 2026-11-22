import { randomBytes } from "node:crypto";
import type { ReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every file opened for reading, so a test can see how far ahead of the client it was read.
const opened = vi.hoisted(() => [] as ReadStream[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args);
      opened.push(stream);
      return stream;
    },
  };
});

describe("Studio project download", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "studio-zip-"));
    opened.length = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads a large file only as fast as the client takes it", async () => {
    const { streamProjectZip } = await import("./checkpoints.js");
    const size = 20 * 1024 * 1024;
    // Random bytes: the zip cannot shrink them, so what is read is what must be sent.
    await writeFile(path.join(root, "clip.mp4"), randomBytes(size));
    let sent = 0;
    let furthestAhead = 0;
    // The client takes each piece a few milliseconds after it is offered.
    await streamProjectZip(root, "", async (chunk) => {
      sent += chunk.length;
      furthestAhead = Math.max(furthestAhead, (opened[0]?.bytesRead ?? 0) - sent);
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
    expect(opened).toHaveLength(1);
    expect(sent).toBeGreaterThan(size);
    // A few pieces read ahead, never the whole file waiting in memory for the client.
    expect(furthestAhead).toBeLessThan(2 * 1024 * 1024);
  });

  it("closes the file it was reading when the client is gone", async () => {
    const { streamProjectZip } = await import("./checkpoints.js");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "clip.mp4"), randomBytes(4 * 1024 * 1024));
    let writes = 0;
    await expect(
      streamProjectZip(root, "", async () => {
        writes += 1;
        if (writes === 2) throw new Error("The download was cancelled.");
      }),
    ).rejects.toThrow("The download was cancelled.");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.destroyed).toBe(true);
    // The rest of the file was never read.
    expect(opened[0]!.bytesRead).toBeLessThan(2 * 1024 * 1024);
  });
});
