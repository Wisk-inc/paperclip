import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { isServerTooOld, retryUnlessServerTooOld } from "./PhoneServerOutdated";

describe("isServerTooOld", () => {
  it("is the server's own missing-route reply", () => {
    expect(isServerTooOld(new ApiError("API route not found", 404, { error: "API route not found" }))).toBe(true);
    expect(isServerTooOld(new ApiError("Request failed: 404", 404, null))).toBe(true);
  });

  it("is not any other 404, nor a refusal", () => {
    expect(isServerTooOld(new ApiError("Project not found", 404, { error: "Project not found" }))).toBe(false);
    expect(isServerTooOld(new ApiError("Forbidden", 403, { error: "Forbidden" }))).toBe(false);
    expect(isServerTooOld(new Error("boom"))).toBe(false);
  });
});

describe("retryUnlessServerTooOld", () => {
  it("asks once for a route the server does not have, and retries other failures", () => {
    expect(retryUnlessServerTooOld(0, new ApiError("API route not found", 404, { error: "API route not found" }))).toBe(false);
    expect(retryUnlessServerTooOld(0, new Error("Failed to fetch"))).toBe(true);
    expect(retryUnlessServerTooOld(3, new Error("Failed to fetch"))).toBe(false);
  });
});
