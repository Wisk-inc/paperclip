import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { assertExecutionTaskParent } from "../services/issues.js";

const dialect = new PgDialect();

/** Rows by issue id, all in company "acme" unless noted: { parentId, companyId, conversationAgentId }. */
function dbWith(rows: Record<string, { parentId?: string | null; companyId?: string; conversationAgentId?: string | null }>) {
  return {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          // The guard always filters by id and company: (id, companyId) are the query's params.
          const [id, companyId] = dialect.sqlToQuery(condition).params as string[];
          const row = rows[id!];
          const matches = row && (row.companyId ?? "acme") === companyId;
          return Promise.resolve(matches ? [{ parentId: row.parentId ?? null, conversationAgentId: row.conversationAgentId ?? null }] : []);
        },
      }),
    }),
  };
}

describe("task parent guard", () => {
  const tree = { a: { parentId: null }, b: { parentId: "a" }, c: { parentId: "b" }, other: { parentId: null, companyId: "beta" } };

  it("accepts a parent in the same organization", async () => {
    await expect(assertExecutionTaskParent(dbWith(tree) as never, "acme", "a", "c")).resolves.toBeUndefined();
    await expect(assertExecutionTaskParent(dbWith(tree) as never, "acme", "b")).resolves.toBeUndefined();
  });

  it("refuses the task itself, one of its own subtasks, and a task of another organization", async () => {
    await expect(assertExecutionTaskParent(dbWith(tree) as never, "acme", "a", "a")).rejects.toThrow("its own parent");
    await expect(assertExecutionTaskParent(dbWith(tree) as never, "acme", "c", "a")).rejects.toThrow("one of its own subtasks");
    await expect(assertExecutionTaskParent(dbWith(tree) as never, "acme", "other", "a")).rejects.toThrow("isn't in this organization");
  });
});
