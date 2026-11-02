import { beforeEach, describe, expect, it, vi } from "vitest";

const listPushTargets = vi.hoisted(() => vi.fn());
const clearPushTokens = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../services/device-files.js", () => ({
  deviceFileService: () => ({ listPushTargets, clearPushTokens }),
}));

const { pushStudioReply } = await import("../services/push-notifier.js");

function dbWithPrefix(prefix: string) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ prefix }] }),
      }),
    }),
  };
}

describe("finished-work notifications go to the person who asked", () => {
  beforeEach(() => {
    listPushTargets.mockReset();
    listPushTargets.mockResolvedValue([{ deviceId: "d1", token: "t1" }]);
  });

  it("sends an App Studio reply only to the asker's phones, opening their organization", async () => {
    const send = vi.fn(async () => ({ sent: 1, invalidTokens: [] }));
    await pushStudioReply(
      dbWithPrefix("ACME") as never,
      { companyId: "c1", workspaceId: "w1", projectName: "Todo", text: "Built it.", error: null, requestedByUserId: "user-ada" },
      { enabled: true, send },
    );
    expect(listPushTargets).toHaveBeenCalledWith("c1", null, { userId: "user-ada" });
    expect(send).toHaveBeenCalledWith([{ token: "t1", deviceId: "d1" }], expect.objectContaining({ path: "/ACME/studio/w1" }));
  });

  it("sends nothing when it can't tell who asked, rather than every member's phone", async () => {
    const send = vi.fn(async () => ({ sent: 0, invalidTokens: [] }));
    await pushStudioReply(
      dbWithPrefix("ACME") as never,
      { companyId: "c1", workspaceId: "w1", projectName: "Todo", text: "Built it.", error: null, requestedByUserId: null },
      { enabled: true, send },
    );
    expect(listPushTargets).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
