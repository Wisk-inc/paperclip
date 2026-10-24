// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadBellSeenKeys, saveBellSeenKeys } from "./inbox";

describe("bell seen list", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a separate list for each organization", () => {
    saveBellSeenKeys(["approval:a"], "org-a");
    saveBellSeenKeys(["issue:b"], "org-b");
    expect([...loadBellSeenKeys("org-a")]).toEqual(["approval:a"]);
    expect([...loadBellSeenKeys("org-b")]).toEqual(["issue:b"]);
    expect(loadBellSeenKeys("org-c").size).toBe(0);
  });
});
