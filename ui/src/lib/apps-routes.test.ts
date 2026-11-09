import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RESERVED_APP_SUBPATHS, appConnectionIdFromSegments } from "./apps-routes";

/** Every `path="apps/<segment>…"` route in App.tsx whose first segment is fixed text, not a parameter. */
function staticAppsSubpaths(): string[] {
  const source = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const segments = new Set<string>();
  for (const match of source.matchAll(/path="apps\/([^"/]+)/g)) {
    if (!match[1]!.startsWith(":")) segments.add(match[1]!);
  }
  return [...segments].sort();
}

describe("reserved Apps subpaths", () => {
  it("covers every fixed apps route, so none is mistaken for a connection id", () => {
    const routes = staticAppsSubpaths();
    // The router does have fixed Apps routes; an empty list would make this test pass for nothing.
    expect(routes).toContain("byo");
    expect(routes.filter((segment) => !RESERVED_APP_SUBPATHS.has(segment))).toEqual([]);
  });

  it("reads a connection id only from a connection's page", () => {
    expect(appConnectionIdFromSegments(["apps", "conn-1", "permissions"])).toBe("conn-1");
    expect(appConnectionIdFromSegments(["apps", "byo"])).toBeNull();
    expect(appConnectionIdFromSegments(["apps", "BYO"])).toBeNull();
    expect(appConnectionIdFromSegments(["apps", "vercel-connect"])).toBeNull();
    expect(appConnectionIdFromSegments(["apps", "app", "app-1"])).toBeNull();
    expect(appConnectionIdFromSegments(["apps"])).toBeNull();
    expect(appConnectionIdFromSegments(["issues", "conn-1"])).toBeNull();
  });
});
