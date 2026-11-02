import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.fn();
const canUserMock = vi.fn();
const hasPermissionMock = vi.fn();
const getMembershipMock = vi.fn();

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      isInstanceAdmin: vi.fn(),
      canUser: (...args: unknown[]) => canUserMock(...args),
      hasPermission: (...args: unknown[]) => hasPermissionMock(...args),
      getMembership: (...args: unknown[]) => getMembershipMock(...args),
    }),
    agentService: () => ({
      getById: vi.fn(),
    }),
    boardAuthService: () => ({
      createChallenge: vi.fn(),
      resolveBoardAccess: vi.fn(),
      assertCurrentBoardKey: vi.fn(),
      revokeBoardApiKey: vi.fn(),
    }),
    deduplicateAgentName: vi.fn(),
    logActivity: (...args: unknown[]) => logActivityMock(...args),
    notifyHireApproved: vi.fn(),
  }));
}

function createDbStub() {
  const createdInvite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { humanRole: "viewer" },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: null,
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };

  return {
    insert() {
      return {
        values() {
          return {
            returning() {
              return Promise.resolve([createdInvite]);
            },
          };
        },
      };
    },
    select(_shape?: unknown) {
      return {
        from() {
          const query = {
            leftJoin() {
              return query;
            },
            where() {
              return Promise.resolve([{
                name: "Acme Robotics",
                logoAssetId: "logo-1",
              }]);
            },
          };
          return query;
        },
      };
    },
  };
}

const localBoard = {
  type: "board",
  source: "local_implicit",
  userId: null,
  companyIds: ["company-1"],
};

async function createApp(actor: Record<string, unknown> = localBoard) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/invites", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    logActivityMock.mockReset();
    canUserMock.mockReset();
    hasPermissionMock.mockReset();
    getMembershipMock.mockReset();
  });

  it("returns an absolute invite URL using the request base URL", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({
        allowedJoinTypes: "human",
        humanRole: "viewer",
      });

    expect(res.status).toBe(201);
    expect(res.body.companyName).toBe("Acme Robotics");
    expect(res.body.invitePath).toMatch(/^\/invite\/pcp_invite_/);
    expect(res.body.inviteUrl).toMatch(/^https:\/\/paperclip\.example\/invite\/pcp_invite_/);
  });

  it("never lets an invite carry a role or agent grants above its creator's", async () => {
    const admin = {
      type: "board",
      source: "session",
      userId: "user-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
    };
    getMembershipMock.mockResolvedValue({ status: "active", membershipRole: "admin" });
    // Admins hold users:invite but not users:manage_permissions.
    canUserMock.mockImplementation(async (_companyId: string, _userId: string, key: string) => key !== "users:manage_permissions");
    const app = await createApp(admin);

    const asOwner = await request(app).post("/api/companies/company-1/invites").send({ allowedJoinTypes: "human", humanRole: "owner" });
    expect(asOwner.status).toBe(403);
    expect(asOwner.body.error).toContain("as admin or below");

    const agentWithMore = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "agent", defaultsPayload: { agent: { grants: [{ permissionKey: "users:manage_permissions" }] } } });
    expect(agentWithMore.status).toBe(403);
    expect(agentWithMore.body.error).toContain("users:manage_permissions");
    expect(logActivityMock).not.toHaveBeenCalled();

    // Within the admin's own rights: allowed.
    const asAdmin = await request(app).post("/api/companies/company-1/invites").send({ allowedJoinTypes: "human", humanRole: "admin" });
    expect(asAdmin.status).toBe(201);
    const agentWithin = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "agent", defaultsPayload: { agent: { grants: [{ permissionKey: "agents:create" }] } } });
    expect(agentWithin.status).toBe(201);
  });
});
