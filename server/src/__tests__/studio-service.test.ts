import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, studioChangeRequests, studioWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { studioService } from "../services/studio/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Studio change requests", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-studio-service-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function newWorkspace() {
    const [company] = await db
      .insert(companies)
      .values({ name: `Studio ${randomUUID()}`, issuePrefix: `ST${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning();
    const [workspace] = await db.insert(studioWorkspaces).values({ companyId: company!.id, name: "Shop", language: "html" }).returning();
    return workspace!;
  }

  it("lets only one of an accept and a reject at the same moment through", async () => {
    const workspace = await newWorkspace();
    const svc = studioService(db);
    for (let round = 0; round < 5; round += 1) {
      const change = await svc.createChangeRequest({ workspace, collaboratorId: null, authorName: "Sam", files: [{ path: "a.txt", before: null, after: "x" }] });
      const results = await Promise.allSettled([
        svc.resolveChangeRequest(workspace.id, change.id, "accepted", "owner"),
        svc.resolveChangeRequest(workspace.id, change.id, "rejected", "owner"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    }
  });

  it("opens an accepted change again, as proposed, and only an accepted one", async () => {
    const workspace = await newWorkspace();
    const svc = studioService(db);
    const proposed = [{ path: "a.txt", before: null, after: "from Sam" }];
    const change = await svc.createChangeRequest({ workspace, collaboratorId: null, authorName: "Sam", files: proposed });
    await svc.resolveChangeRequest(workspace.id, change.id, "accepted", "owner", [{ path: "a.txt", before: null, after: "edited" }]);
    await svc.reopenChangeRequest(workspace.id, change.id, proposed);
    const [row] = await db.select().from(studioChangeRequests).where(eq(studioChangeRequests.id, change.id));
    expect(row).toMatchObject({ status: "open", resolvedAt: null, resolvedByUserId: null, files: proposed });

    await svc.resolveChangeRequest(workspace.id, change.id, "rejected", "owner");
    await svc.reopenChangeRequest(workspace.id, change.id, proposed);
    expect((await svc.getChangeRequest(workspace.id, change.id)).status).toBe("rejected");
  });
});
