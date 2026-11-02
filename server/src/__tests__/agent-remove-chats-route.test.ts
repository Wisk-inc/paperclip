import express from "express";
import request from "supertest";
import { issues } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const chatA = "44444444-4444-4444-8444-444444444444";
const chatB = "55555555-5555-4555-8555-555555555555";

const baseAgent = { id: agentId, companyId, name: "Builder", status: "idle" };

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn(), remove: vi.fn() }));
const mockIssueService = vi.hoisted(() => ({ listAttachments: vi.fn(), remove: vi.fn() }));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn(), canUser: vi.fn(), hasPermission: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockDeleteObject = vi.hoisted(() => vi.fn());
const chatRows = vi.hoisted(() => ({ rows: [] as Array<{ id: string }> }));
const order = vi.hoisted(() => [] as string[]);

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));
vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({ deleteObject: mockDeleteObject }),
}));

vi.mock("../routes/authz.js", async () => {
  const { forbidden, unauthorized } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
  function assertAuthenticated(req: Express.Request) {
    if (req.actor.type === "none") throw unauthorized();
  }
  function assertBoard(req: Express.Request) {
    if (req.actor.type !== "board") throw forbidden("Board access required");
  }
  function hasCompanyAccess(req: Express.Request, expected: string) {
    if (req.actor.type === "agent") return req.actor.companyId === expected;
    if (req.actor.source === "local_implicit") return true;
    return (req.actor.companyIds ?? []).includes(expected);
  }
  function assertCompanyAccess(req: Express.Request, expected: string) {
    assertAuthenticated(req);
    if (!hasCompanyAccess(req, expected)) throw forbidden("User does not have access to this company");
  }
  async function getAccessibleResource<T extends { companyId: string }>(
    req: Express.Request,
    res: { status(code: number): { json(body: unknown): unknown } },
    resource: T | null | undefined | Promise<T | null | undefined>,
    notFoundMessage: string,
  ): Promise<T | null> {
    const resolved = await resource;
    if (!resolved || !hasCompanyAccess(req, resolved.companyId)) {
      res.status(404).json({ error: notFoundMessage });
      return null;
    }
    return resolved;
  }
  function assertInstanceAdmin(req: Express.Request) {
    assertBoard(req);
  }
  function getActorInfo(req: Express.Request) {
    return { actorType: "user" as const, actorId: req.actor.userId ?? "board", agentId: null, runId: null, agentApiKeyId: null };
  }
  return { assertAuthenticated, assertBoard, assertCompanyAccess, assertInstanceAdmin, getAccessibleResource, getActorInfo, hasCompanyAccess };
});

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })) }),
}));

/** The agent's chats are the only issues read; other reads (start-up cleanup) see nothing. */
const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => {
        if (table !== issues) return Promise.resolve([]);
        order.push("list-chats");
        return Promise.resolve(chatRows.rows);
      },
    }),
  }),
};

async function createApp() {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/agents.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "owner-1", source: "session", companyIds: [companyId] };
    next();
  });
  app.use("/api", agentRoutes(fakeDb as any));
  app.use(errorHandler);
  return app;
}

async function deleteAgent() {
  const app = await createApp();
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return await request(`http://127.0.0.1:${address.port}`).delete(`/api/agents/${agentId}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("DELETE /agents/:id removes the agent's chats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    chatRows.rows = [{ id: chatA }, { id: chatB }];
    mockAccessService.decide.mockResolvedValue({ allowed: true, explanation: "" });
    mockAgentService.getById.mockResolvedValue({ ...baseAgent });
    mockAgentService.remove.mockImplementation(async () => {
      order.push("remove-agent");
      return { ...baseAgent };
    });
    mockIssueService.listAttachments.mockImplementation(async (issueId: string) =>
      issueId === chatA ? [{ id: "att-1", companyId, objectKey: "chats/a/photo.png" }] : [],
    );
    mockIssueService.remove.mockImplementation(async (issueId: string) => {
      order.push(`remove-chat:${issueId}`);
      return { id: issueId, companyId };
    });
    mockDeleteObject.mockResolvedValue(undefined);
  });

  it("finds the chats before the agent goes, then deletes them and their files", async () => {
    const res = await deleteAgent();

    expect(res.status).toBe(200);
    expect(order).toEqual(["list-chats", "remove-agent", `remove-chat:${chatA}`, `remove-chat:${chatB}`]);
    expect(mockDeleteObject).toHaveBeenCalledWith(companyId, "chats/a/photo.png");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "agent.deleted" }));
  });

  it("keeps going when one chat can't be deleted (it stays hidden), and keeps that chat's files", async () => {
    mockIssueService.remove.mockImplementation(async (issueId: string) => {
      if (issueId === chatA) throw new Error("another record still references it");
      order.push(`remove-chat:${issueId}`);
      return { id: issueId, companyId };
    });

    const res = await deleteAgent();

    expect(res.status).toBe(200);
    expect(order).toContain(`remove-chat:${chatB}`);
    // The chat that stayed (hidden) still owns its attachment, so its file is kept.
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("deletes no chats when the agent removal is refused", async () => {
    const { conflict } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockAgentService.remove.mockRejectedValue(conflict("Builder is still working. Stop its run before removing it."));

    const res = await deleteAgent();

    expect(res.status).toBe(409);
    expect(mockIssueService.remove).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });
});
