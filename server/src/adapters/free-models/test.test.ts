import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFreeModelHealth } from "@paperclipai/shared/puter-ai";
import type { AdapterEnvironmentTestContext } from "../types.js";
import { testEnvironment } from "./test.js";

const ctx = { companyId: "company-1", adapterType: "free_models", config: {} } as AdapterEnvironmentTestContext;
const rateLimited = (upstream: string) => JSON.stringify({ error: "AI provider rate limit exceeded", code: "upstream_rate_limited", attempts: [{ status: 429, error: upstream }] });

/** Every call to the free-model service gets `reply()`; the calls are counted. */
function serve(reply: () => Response) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => reply());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const refusal = (status: number, body: string) => () => new Response(body, { status, headers: { "content-type": "application/json" } });

beforeEach(() => resetFreeModelHealth());
afterEach(() => vi.unstubAllGlobals());

describe("free models connection test", () => {
  it("passes when the default model answers", async () => {
    serve(() => new Response(JSON.stringify({ success: true, result: { message: { content: "OK" } } }), { status: 200 }));
    const result = await testEnvironment(ctx);
    expect(result.status).toBe("pass");
    expect(result.checks).toEqual([{ code: "free_models_reachable", level: "info", message: "The free models answered." }]);
  });

  it("warns in plain words when the default model is at its daily limit, and says to pick another model", async () => {
    const fetchMock = serve(refusal(429, rateLimited("429 Rate limit exceeded: free-models-per-day-high-balance. ")));
    const result = await testEnvironment(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The service answered, so this is not a failed connection.
    expect(result.status).toBe("warn");
    const [check] = result.checks;
    expect(check).toMatchObject({ code: "free_models_default_model_unavailable", level: "warn" });
    // The allowance most free models share: said as that, with the models that still answer.
    expect(check!.message).toContain("Nemotron 3 Ultra 550B can't answer for now");
    expect(check!.message).toContain("one daily allowance of free requests");
    expect(check!.message).toContain("still answer");
    // Never the service's raw reply.
    expect(check!.message).not.toContain("{");
    expect(check!.message).not.toContain("Free model service answered");
    expect(check!.hint).toContain("Pick another model");
    expect(check!.hint).not.toContain("internet connection");
  });

  it("warns when the default model is only busy", async () => {
    serve(refusal(429, rateLimited("429 Provider returned error")));
    const result = await testEnvironment(ctx);
    expect(result.status).toBe("warn");
    expect(result.checks[0]!.message).toContain("Nemotron 3 Ultra 550B is busy at its provider right now");
    expect(result.checks[0]!.message).not.toContain("{");
    expect(result.checks[0]!.hint).toContain("Pick another model");
  });

  it("says to wait, not to pick another model, when the service itself asks Automa to slow down", async () => {
    serve(refusal(429, JSON.stringify({ error: "Too many AI requests from this account, network or device. Try again in a minute.", code: "too_many_requests" })));
    const result = await testEnvironment(ctx);
    expect(result.status).toBe("warn");
    expect(result.checks[0]!.message).toContain("The free AI service asked Automa to slow down");
    expect(result.checks[0]!.message).not.toContain("{");
    expect(result.checks[0]!.hint).toBe("Test again in a minute.");
  });

  it("fails in plain words when the service cannot be reached, and says to check the connection", async () => {
    serve(() => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.puter.com"), { code: "EAI_AGAIN" }) }); });
    const result = await testEnvironment(ctx);
    expect(result.status).toBe("fail");
    expect(result.checks[0]).toMatchObject({ code: "free_models_unreachable", level: "error" });
    expect(result.checks[0]!.message).toBe("Automa could not reach the free model service.");
    expect(result.checks[0]!.hint).toContain("internet connection");
  });

  it("fails without the raw reply when the service rejects the request", async () => {
    serve(refusal(401, JSON.stringify({ code: "token_auth_failed", message: "Authentication failed." })));
    const result = await testEnvironment(ctx);
    expect(result.status).toBe("fail");
    expect(result.checks[0]!.message).toContain("Nemotron 3 Ultra 550B rejected the request: Authentication failed. ");
    expect(result.checks[0]!.message).not.toContain("{");
    expect(result.checks[0]!.hint).not.toContain("internet connection");
  });
});
