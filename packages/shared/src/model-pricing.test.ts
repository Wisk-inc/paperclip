import { describe, expect, it } from "vitest";
import { claudeModelPrice, estimateClaudeCostUsd } from "./model-pricing.js";

describe("claudeModelPrice", () => {
  it("prices the same model however its id is written", () => {
    const opus45 = claudeModelPrice("claude-opus-4-5");
    for (const id of [
      "claude-opus-4-5-20251101",
      "claude-opus-4.5",
      "claude-opus-4-5@20251101",
      "us.anthropic.claude-opus-4-5-20251101-v1:0",
      "us-gov.anthropic.claude-opus-4-5-20251101-v1:0",
      "jp.anthropic.claude-opus-4-5-20251101-v1:0",
      "anthropic/claude-opus-4.5",
      "claude-opus-4-5[1m]",
    ]) {
      expect(claudeModelPrice(id), id).toEqual(opus45);
    }
    expect(opus45).toMatchObject({ input: 5, output: 25 });
    expect(claudeModelPrice("claude-haiku-4.5")).toMatchObject({ input: 1, output: 5 });
  });

  it("reads Claude Code's short aliases as the newest model", () => {
    expect(claudeModelPrice("opus")).toEqual(claudeModelPrice("claude-opus-5-5"));
    expect(claudeModelPrice("sonnet")).toEqual(claudeModelPrice("claude-sonnet-5-5"));
    expect(claudeModelPrice("haiku")).toEqual(claudeModelPrice("claude-haiku-5-5"));
  });

  it("returns null for models it doesn't know", () => {
    expect(claudeModelPrice("my-gateway-model")).toBeNull();
    expect(estimateClaudeCostUsd("my-gateway-model", { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it("charges cache reads and writes", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache reads, writes at 1.25x input.
    const cost = estimateClaudeCostUsd("claude-opus-5-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
  });
});
