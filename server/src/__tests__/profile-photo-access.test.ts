import { describe, expect, it } from "vitest";
import { isSharedProfilePhoto } from "../routes/assets.js";

function dbReturning(...responses: unknown[][]) {
  let call = 0;
  return {
    select() {
      const rows = responses[call] ?? [];
      call += 1;
      const query = {
        where: () => query,
        limit: () => query,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return { from: () => query };
    },
  };
}

const board = (userId: string, companyIds: string[]) => ({ actor: { type: "board", source: "session", userId, companyIds } });

describe("isSharedProfilePhoto", () => {
  it("shows a person's photo to them and to people who share an organization with them", async () => {
    // Ada's photo lives in org A's files; Ada sees it from anywhere.
    expect(await isSharedProfilePhoto(dbReturning([{ id: "ada" }]) as never, board("ada", ["org-b"]) as never, "asset-1")).toBe(true);
    // Sam shares org B with Ada.
    expect(await isSharedProfilePhoto(dbReturning([{ id: "ada" }], [{ id: "m1" }]) as never, board("sam", ["org-b"]) as never, "asset-1")).toBe(true);
  });

  it("keeps everything else private", async () => {
    // A stranger with no organization in common.
    expect(await isSharedProfilePhoto(dbReturning([{ id: "ada" }], []) as never, board("eve", ["org-z"]) as never, "asset-1")).toBe(false);
    // Not anyone's photo: an ordinary file.
    expect(await isSharedProfilePhoto(dbReturning([]) as never, board("sam", ["org-b"]) as never, "asset-2")).toBe(false);
    // Agents never get this exception.
    expect(await isSharedProfilePhoto(dbReturning([{ id: "ada" }]) as never, { actor: { type: "agent", companyId: "org-b" } } as never, "asset-1")).toBe(false);
  });
});
