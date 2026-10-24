import { describe, expect, it, vi } from "vitest";
import { fetchOpenRouterCredits } from "../routes/ai-connections.js";

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
