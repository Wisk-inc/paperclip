import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { GUEST_NETWORK_ERROR_MESSAGE, studioGuestApi } from "./studio";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("studioGuestApi (the page an invited collaborator uses)", () => {
  it("says the session can't be reached in plain words, never the browser's 'Failed to fetch'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const joining = studioGuestApi.join("ABC123", "Kemar");
    await expect(joining).rejects.toBeInstanceOf(ApiError);
    await expect(joining).rejects.toMatchObject({ status: 0, message: GUEST_NETWORK_ERROR_MESSAGE });
  });

  it("keeps a real answer from the server as it is", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "That code has ended." }), { status: 401 })));
    await expect(studioGuestApi.join("ABC123", "Kemar")).rejects.toMatchObject({ status: 401, message: "That code has ended." });
  });

  it("passes an abort on unchanged", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("The operation was aborted.", "AbortError")));
    await expect(studioGuestApi.join("ABC123", "Kemar")).rejects.toMatchObject({ name: "AbortError" });
  });
});
