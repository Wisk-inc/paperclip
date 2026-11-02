import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const inspector = vi.hoisted(() => ({
  startDecode: vi.fn(async () => ({ id: "66666666-6666-4666-8666-666666666666" })),
  resolveInstalledApkPath: vi.fn(async () => ({ apkPath: "/data/app/base.apk", splitCount: 2 })),
}));
vi.mock("../services/app-inspector/inspector.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/app-inspector/inspector.js")>()),
  startDecode: inspector.startDecode,
  resolveInstalledApkPath: inspector.resolveInstalledApkPath,
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ credentialForProvider: async () => null }) }));

async function app() {
  const [{ appInspectorRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/app-inspector.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: true };
    next();
  });
  server.use("/api", appInspectorRoutes({} as any, { deploymentMode: "local_trusted", deploymentExposure: "private" }));
  server.use(errorHandler);
  return server;
}

describe("App Inspector: an installed app's parts", () => {
  it("counts them from the phone itself, whatever count the page sent", async () => {
    const res = await request(await app())
      .post("/api/companies/company-1/app-inspector/projects")
      .send({ source: { kind: "installed", package: "com.example.app" }, splitCount: 0 });

    expect(res.status).toBeLessThan(300);
    expect(inspector.startDecode).toHaveBeenCalledWith(expect.objectContaining({ apkPath: "/data/app/base.apk", splitCount: 2 }));
  });

  it("takes the page's count for an APK picked by path, which has no installed parts to count", async () => {
    inspector.startDecode.mockClear();
    const res = await request(await app())
      .post("/api/companies/company-1/app-inspector/projects")
      .send({ source: { kind: "path", apkPath: "/sdcard/Download/app.apk" }, splitCount: 3 });

    expect(res.status).toBeLessThan(300);
    expect(inspector.startDecode).toHaveBeenCalledWith(expect.objectContaining({ apkPath: "/sdcard/Download/app.apk", splitCount: 3 }));
  });
});
