import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  companies,
  companyDevices,
  deviceFileRequests,
  deviceFiles,
  issues,
} from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import { deviceFileService } from "../services/device-files.js";

const mockHeartbeat = vi.hoisted(() => ({ wakeup: vi.fn(async () => ({ id: "run-woken" })) }));

vi.mock("../services/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/index.js")>()),
  heartbeatService: () => mockHeartbeat,
}));

const { deviceFileRoutes, decodeUploadFilename, contentDisposition } = await import("../routes/device-files.js");
const { errorHandler } = await import("../middleware/index.js");
const { normalizeSharedIndex } = await import("../services/device-files.js");

function memoryStorage(): StorageService & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    provider: "local_disk",
    async putFile(input) {
      const objectKey = `${input.namespace}/${randomUUID()}`;
      objects.set(`${input.companyId}:${objectKey}`, input.body);
      return {
        provider: "local_disk",
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: "sha-" + input.body.length,
        originalFilename: input.originalFilename,
      };
    },
    async getObject(companyId, objectKey) {
      const body = objects.get(`${companyId}:${objectKey}`);
      if (!body) throw new Error("missing object");
      return { stream: Readable.from(body), contentLength: body.length };
    },
    async headObject(companyId, objectKey) {
      return { exists: objects.has(`${companyId}:${objectKey}`) };
    },
    async deleteObject(companyId, objectKey) {
      objects.delete(`${companyId}:${objectKey}`);
    },
  };
}

type Actor = Record<string, unknown>;

describe("device file upload helpers", () => {
  it("recovers UTF-8 filenames that multer decoded as latin1", () => {
    const utf8Name = "résumé 📄.pdf";
    const asLatin1 = Buffer.from(utf8Name, "utf8").toString("latin1");
    expect(decodeUploadFilename(asLatin1)).toBe(utf8Name);
    expect(decodeUploadFilename("../../etc/passwd")).toBe("passwd");
    expect(decodeUploadFilename("")).toBe("file");
  });

  it("writes an ASCII fallback plus an RFC 6266 UTF-8 filename", () => {
    expect(contentDisposition("attachment", "résumé.pdf")).toBe(
      "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
    );
  });

  it("dedupes and sorts a reported shared-folder listing", () => {
    const entry = (path: string) => ({ path, byteSize: 1, contentType: null, modifiedAt: null });
    expect(normalizeSharedIndex([entry("b.txt"), entry("a.txt"), entry("b.txt")]).map((e) => e.path)).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });
});

describeEmbeddedPostgres("device file routes", () => {
  const ctx = useEmbeddedPostgres("paperclip-device-files-routes-", {
    resetEach: async (db) => {
      await db.delete(deviceFileRequests);
      await db.delete(deviceFiles);
      await db.delete(companyDevices);
      await db.delete(assets);
      await db.delete(activityLog);
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(companies);
      mockHeartbeat.wakeup.mockClear();
    },
  });

  async function seed() {
    const db = ctx.db;
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Device Co", issuePrefix: `D${companyId.slice(0, 5).toUpperCase()}` },
      { id: otherCompanyId, name: "Other Co", issuePrefix: `O${otherCompanyId.slice(0, 5).toUpperCase()}` },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Researcher", role: "engineer", status: "idle", adapterType: "process" },
      { id: otherAgentId, companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process" },
    ]);
    const storage = memoryStorage();
    const board: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
    const agent = (id: string, company = companyId): Actor => ({ type: "agent", agentId: id, companyId: company, source: "agent_key", keyId: "key-1" });
    const app = (actor: Actor) => {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        (req as unknown as { actor: Actor }).actor = actor;
        next();
      });
      server.use("/api", deviceFileRoutes(db, storage));
      server.use(errorHandler);
      return request(server);
    };
    return { companyId, otherCompanyId, agentId, otherAgentId, storage, board, agent, app };
  }

  it("lets an agent request a file, a device fulfil it, and wakes the agent", async () => {
    const s = await seed();
    const board = s.app(s.board);
    const agent = s.app(s.agent(s.agentId));

    const registered = await board
      .post(`/api/companies/${s.companyId}/devices`)
      .send({ name: "Pixel 8", platform: "android", clientKey: "android-test-key-1" })
      .expect(201);
    const deviceId = registered.body.id as string;

    // Re-registering the same install is idempotent.
    const again = await board
      .post(`/api/companies/${s.companyId}/devices`)
      .send({ name: "Pixel 8 Pro", platform: "android", clientKey: "android-test-key-1" })
      .expect(200);
    expect(again.body.id).toBe(deviceId);
    expect(again.body.name).toBe("Pixel 8 Pro");

    await board
      .put(`/api/devices/${deviceId}/shared-index`)
      .send({
        sharedFolderName: "Documents",
        entries: [
          { path: "reports/q3.pdf", byteSize: 5, contentType: "application/pdf", modifiedAt: null },
          { path: "notes.txt", byteSize: 3, contentType: "text/plain", modifiedAt: null },
        ],
      })
      .expect(200);

    const seen = await agent.get(`/api/devices/${deviceId}`).expect(200);
    expect(seen.body.sharedFolderName).toBe("Documents");
    expect(seen.body.sharedIndex.map((e: { path: string }) => e.path)).toEqual(["notes.txt", "reports/q3.pdf"]);

    const created = await agent
      .post(`/api/companies/${s.companyId}/device-file-requests`)
      .send({ deviceId, title: "Q3 report", devicePath: "reports/q3.pdf" })
      .expect(201);
    expect(created.body.status).toBe("pending");
    expect(created.body.requestedByAgentId).toBe(s.agentId);

    const heartbeat = await board.post(`/api/devices/${deviceId}/heartbeat`).expect(200);
    expect(heartbeat.body.pendingRequests.map((r: { id: string }) => r.id)).toEqual([created.body.id]);

    const fulfilled = await board
      .post(`/api/device-file-requests/${created.body.id}/fulfill`)
      .field("deviceId", deviceId)
      .field("devicePath", "reports/q3.pdf")
      .attach("file", Buffer.from("%PDF-"), { filename: "q3.pdf", contentType: "application/pdf" })
      .expect(200);
    expect(fulfilled.body.status).toBe("fulfilled");
    expect(fulfilled.body.file.filename).toBe("q3.pdf");
    expect(fulfilled.body.file.sourceDeviceId).toBe(deviceId);

    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      s.agentId,
      expect.objectContaining({
        reason: "device_file_request_fulfilled",
        payload: expect.objectContaining({ deviceFileRequestId: created.body.id, deviceFileId: fulfilled.body.file.id }),
      }),
    );

    const detail = await agent.get(`/api/device-file-requests/${created.body.id}`).expect(200);
    expect(detail.body.file.id).toBe(fulfilled.body.file.id);

    const content = await agent.get(`/api/device-files/${fulfilled.body.file.id}/content`).expect(200);
    expect(content.headers["content-type"]).toContain("application/pdf");
    expect(Buffer.from(content.body).toString()).toBe("%PDF-");

    // A second answer loses the race cleanly.
    await board
      .post(`/api/device-file-requests/${created.body.id}/fulfill`)
      .attach("file", Buffer.from("again"), { filename: "again.txt", contentType: "text/plain" })
      .expect(409);
  });

  it("wakes the requester when a request is declined, and lets agents cancel only their own requests", async () => {
    const s = await seed();
    const board = s.app(s.board);
    const requester = s.app(s.agent(s.agentId));
    const other = s.app(s.agent(s.otherAgentId));

    const first = await requester
      .post(`/api/companies/${s.companyId}/device-file-requests`)
      .send({ title: "Boarding pass" })
      .expect(201);
    await board.post(`/api/device-file-requests/${first.body.id}/decline`).send({ note: "Not on this phone" }).expect(200);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      s.agentId,
      expect.objectContaining({ reason: "device_file_request_declined" }),
    );

    const second = await requester
      .post(`/api/companies/${s.companyId}/device-file-requests`)
      .send({ title: "Receipt" })
      .expect(201);
    await other.post(`/api/device-file-requests/${second.body.id}/cancel`).expect(403);
    const cancelled = await requester.post(`/api/device-file-requests/${second.body.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe("cancelled");
  });

  it("keeps devices board-only, files company-scoped, and device paths inside the shared folder", async () => {
    const s = await seed();
    const board = s.app(s.board);
    const agent = s.app(s.agent(s.agentId));
    const outsider = s.app(s.agent(randomUUID(), s.otherCompanyId));

    await agent
      .post(`/api/companies/${s.companyId}/devices`)
      .send({ name: "Agent phone", platform: "android", clientKey: "android-test-key-2" })
      .expect(403);

    const device = await board
      .post(`/api/companies/${s.companyId}/devices`)
      .send({ name: "Laptop browser", platform: "web", clientKey: "web-test-key-3" })
      .expect(201);

    await agent
      .post(`/api/companies/${s.companyId}/device-files`)
      .field("sourceDeviceId", device.body.id)
      .attach("file", Buffer.from("x"), { filename: "x.txt", contentType: "text/plain" })
      .expect(403);

    const sent = await agent
      .post(`/api/companies/${s.companyId}/device-files`)
      .field("targetDeviceId", device.body.id)
      .attach("file", Buffer.from("hello"), { filename: "summary.md", contentType: "text/markdown" })
      .expect(201);
    expect(sent.body.targetDeviceId).toBe(device.body.id);
    expect(sent.body.uploadedByAgentId).toBe(s.agentId);

    await outsider.get(`/api/device-files/${sent.body.id}`).expect(404);
    await outsider.get(`/api/companies/${s.companyId}/device-files`).expect(403);

    const listed = await board.get(`/api/companies/${s.companyId}/device-files?targetDeviceId=${device.body.id}`).expect(200);
    expect(listed.body.map((f: { id: string }) => f.id)).toEqual([sent.body.id]);

    await agent
      .post(`/api/companies/${s.companyId}/device-file-requests`)
      .send({ title: "Escape", devicePath: "../secrets.txt" })
      .expect(400);

    await s.app(s.agent(s.otherAgentId)).delete(`/api/device-files/${sent.body.id}`).expect(403);
    await agent.delete(`/api/device-files/${sent.body.id}`).expect(200);
    expect(s.storage.objects.size).toBe(0);
  });

  it("keeps a device's push token on the server, reports only pushEnabled, and forgets it on removal", async () => {
    const s = await seed();
    const board = s.app(s.board);
    const agent = s.app(s.agent(s.agentId));
    const svc = deviceFileService(ctx.db);

    const device = await board
      .post(`/api/companies/${s.companyId}/devices`)
      .send({ name: "Pixel 8", platform: "android", clientKey: "android-push-key-1", pushToken: "fcm-token-abc" })
      .expect(201);
    expect(device.body.pushEnabled).toBe(true);
    expect(JSON.stringify(device.body)).not.toContain("fcm-token-abc");

    const listed = await agent.get(`/api/companies/${s.companyId}/devices`).expect(200);
    expect(listed.body[0].pushEnabled).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain("fcm-token-abc");

    await expect(svc.listPushTargets(s.companyId, null)).resolves.toEqual([{ deviceId: device.body.id, token: "fcm-token-abc" }]);
    await expect(svc.listPushTargets(s.otherCompanyId, null)).resolves.toEqual([]);

    await board.patch(`/api/devices/${device.body.id}`).send({ pushToken: "fcm-token-rotated" }).expect(200);
    await expect(svc.listPushTargets(s.companyId, device.body.id)).resolves.toEqual([{ deviceId: device.body.id, token: "fcm-token-rotated" }]);

    await svc.clearPushTokens(["fcm-token-rotated"]);
    await expect(svc.listPushTargets(s.companyId, null)).resolves.toEqual([]);

    await board.patch(`/api/devices/${device.body.id}`).send({ pushToken: "fcm-token-again" }).expect(200);
    await board.delete(`/api/devices/${device.body.id}`).expect(200);
    await expect(svc.listPushTargets(s.companyId, null)).resolves.toEqual([]);
  });
});
