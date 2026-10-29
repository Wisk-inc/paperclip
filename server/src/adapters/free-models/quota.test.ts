import { afterEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  allowance: vi.fn(),
  health: vi.fn(() => ({})),
}));

vi.mock("@paperclipai/shared/puter-ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@paperclipai/shared/puter-ai")>();
  return { ...real, freeModelAllowance: service.allowance, freeModelHealth: service.health };
});

const { getFreeModelQuotaWindows } = await import("./quota.js");
const { PUTER_MODELS } = await import("@paperclipai/shared/puter-ai");

afterEach(() => vi.clearAllMocks());

describe("free model usage limits", () => {
  it("shows the month's allowance, then models at their daily limit, then the busiest", async () => {
    const backAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    service.allowance.mockResolvedValue({
      allowance: 1000,
      remaining: 634,
      unit: "credits",
      requestsByModel: { [PUTER_MODELS["nemotron-ultra"]]: 186, [PUTER_MODELS["deepseek-flash"]]: 40, [PUTER_MODELS["qwen-27b"]]: 13 },
      checkedAt: new Date().toISOString(),
    });
    service.health.mockReturnValue({
      [PUTER_MODELS["deepseek-flash"]]: { state: "daily_limit", until: backAt, checkedAt: new Date().toISOString() },
      [PUTER_MODELS["qwen-27b"]]: { state: "busy", until: backAt, checkedAt: new Date().toISOString() },
    });

    const result = await getFreeModelQuotaWindows();
    expect(result).toMatchObject({ provider: "free_models", ok: true });
    const [allowance, ...models] = result.windows;
    expect(allowance).toMatchObject({ label: "Monthly allowance", valueLabel: "634 of 1,000 credits left" });
    expect(allowance!.usedPercent).toBeCloseTo(36.6, 1);
    // The allowance renews with the calendar month.
    const renews = new Date(allowance!.resetsAt!);
    expect(renews.getUTCDate()).toBe(1);
    expect(renews.getTime()).toBeGreaterThan(Date.now());
    expect(models.map((window) => [window.label, window.usedPercent, window.valueLabel])).toEqual([
      ["DeepSeek V4.1 Flash", 100, "Daily limit reached"],
      ["Nemotron 3 Ultra 550B", null, "Available"],
      ["Qwen 3.8 27B", null, "Busy right now"],
    ]);
    expect(models[0]).toMatchObject({ resetsAt: backAt, detail: "40 requests this month" });
  });

  it("says why when the usage report cannot be read", async () => {
    service.allowance.mockRejectedValue(new Error("Free model service answered 503"));
    const result = await getFreeModelQuotaWindows();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Couldn't read the free models' usage");
    expect(result.windows).toEqual([]);
  });
});
