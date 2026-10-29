import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

import { errorHandler } from "../middleware/error-handler.js";
import {
  loadPaperclipCloudConnectorIdentity,
  startPaperclipCloudConnectorEnrollment,
} from "../services/paperclip-cloud-connector-enrollment.js";
import { toolAccessRoutes } from "./tool-access.js";

const ENV_KEYS = [
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_CLOUD_CONNECTOR_ENROLLMENT",
  "PAPERCLIP_CLOUD_CONNECTOR_BASE_URL",
  "PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT",
] as const;

/** Every query resolves to `rows`; the routes under test read at most one company. */
function stubDb(rows: unknown[]): Db {
  const chain: unknown = new Proxy(() => chain, {
    get: (_target, property) =>
      property === "then" ? (resolve: (value: unknown) => unknown) => resolve(rows) : () => chain,
    apply: () => chain,
  });
  return chain as Db;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      userName: "Board User",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", toolAccessRoutes(stubDb([{ id: "company-1", issuePrefix: "AUT" }])));
  app.use(errorHandler);
  return app;
}

describe("Paperclip Cloud enrollment routes on a server that does not offer enrollment", () => {
  const saved = new Map<string, string | undefined>();
  let root = "";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    root = mkdtempSync(path.join(os.tmpdir(), "paperclip-cloud-enrollment-routes-"));
    process.env.PAPERCLIP_HOME = root;
    process.env.PAPERCLIP_INSTANCE_ID = "enrollment-routes-test";
    process.env.PAPERCLIP_CLOUD_CONNECTOR_BASE_URL = "https://my.example.test";
    process.env.PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT = "development";
    delete process.env.PAPERCLIP_CLOUD_CONNECTOR_ENROLLMENT;
    fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("says enrollment is not offered unless an operator turns it on", async () => {
    const off = await request(createApp()).get("/api/tools/oauth/cloud-connector/enrollment");
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ configured: false, enrollmentAvailable: false });

    process.env.PAPERCLIP_CLOUD_CONNECTOR_ENROLLMENT = "on";
    const on = await request(createApp()).get("/api/tools/oauth/cloud-connector/enrollment");
    expect(on.body).toMatchObject({ configured: false, enrollmentAvailable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to start an enrollment without contacting the cloud", async () => {
    const res = await request(createApp())
      .post("/api/tools/oauth/cloud-connector/enrollment")
      .send({ companyId: "company-1" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("paperclip_cloud_connector_enrollment_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadPaperclipCloudConnectorIdentity()).toBeNull();
  });

  it("does not finish an enrollment that was started before enrollment was turned off", async () => {
    await startPaperclipCloudConnectorEnrollment({
      origin: "https://automa.example.test",
      companyId: "company-1",
      env: process.env,
      request: (async () => Response.json({
        enrollmentId: "enroll-test",
        verificationUrl: "https://my.example.test/connections/enroll?id=enroll-test",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, { status: 201 })) as typeof fetch,
    });
    const pending = loadPaperclipCloudConnectorIdentity();
    expect(pending?.status).toBe("pending");

    const res = await request(createApp())
      .get("/api/tools/oauth/cloud-connector/enrollment-callback")
      .query({ enrollment_id: "enroll-test", approval_code: "approval", state: pending?.pending?.returnState });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("paperclip_cloud_connector_enrollment_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadPaperclipCloudConnectorIdentity()?.status).toBe("pending");
  });
});
