import { describe, expect, it, vi } from "vitest";
import { aiBalanceNote, fetchOpenRouterCredits } from "../routes/ai-connections.js";

describe("OpenRouter balance", () => {
  it("reports the credit left from the credits endpoint, with the key only in the header", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: { total_credits: 25, total_usage: 7.5 } }), { status: 200 }));
    await expect(fetchOpenRouterCredits("sk-or-test", request as unknown as typeof fetch)).resolves.toEqual({ totalCreditsUsd: 25, remainingUsd: 17.5 });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/credits");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
  });

  it("fails on a refusal or a reply without numbers", async () => {
    await expect(fetchOpenRouterCredits("k", (async () => new Response("no", { status: 401 })) as unknown as typeof fetch)).rejects.toThrow(/401/);
    await expect(fetchOpenRouterCredits("k", (async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof fetch)).rejects.toThrow(/no balance/);
  });
});

describe("why a key shows no balance", () => {
  it("asks OpenRouter only for a connected key, and says why otherwise", () => {
    expect(aiBalanceNote({ provider: "openrouter", method: "api_key", status: "connected" })).toBeNull();
    // A key that isn't connected never answers, so it isn't told to try again.
    for (const status of ["revoked", "expired", "needs_attention"] as const)
      expect(aiBalanceNote({ provider: "openrouter", method: "api_key", status })).toMatch(/isn't connected/);
    expect(aiBalanceNote({ provider: "anthropic", method: "api_key", status: "connected" })).toMatch(/console/);
    expect(aiBalanceNote({ provider: "openai", method: "subscription", status: "connected" })).toMatch(/usage limits/);
  });
});
