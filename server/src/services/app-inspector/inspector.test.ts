import path from "node:path";
import { describe, expect, it } from "vitest";
import { confineToBase } from "./inspector.js";

describe("App Inspector path confinement", () => {
  const base = "/tmp/proj/decoded";
  it("keeps paths inside the decoded tree", () => {
    expect(confineToBase(base, "AndroidManifest.xml")).toBe(path.join(base, "AndroidManifest.xml"));
    expect(confineToBase(base, "res/values/strings.xml")).toBe(path.join(base, "res/values/strings.xml"));
    expect(confineToBase(base, "/leading/slash.txt")).toBe(path.join(base, "leading/slash.txt"));
    expect(confineToBase(base, "")).toBe(base);
  });
  it("refuses anything that climbs out", () => {
    expect(() => confineToBase(base, "../../etc/passwd")).toThrow(/escapes/);
    expect(() => confineToBase(base, "a/../../../root/.ssh/id_rsa")).toThrow(/escapes/);
    expect(() => confineToBase(base, "..")).toThrow(/escapes/);
  });
});
