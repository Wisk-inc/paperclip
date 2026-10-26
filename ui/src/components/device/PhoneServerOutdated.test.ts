import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { isServerTooOld } from "./PhoneServerOutdated";

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
