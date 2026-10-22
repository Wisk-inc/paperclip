import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { resolveThinkingLevel, thinkingLevelsFor } from "./ThinkingDepthControl";

const agent = (model: string, adapterType = "claude_local") =>
  ({ adapterType, adapterConfig: { model } }) as unknown as Pick<Agent, "adapterType" | "adapterConfig">;

describe("thinking levels", () => {
  it("lists Auto plus the levels the model takes", () => {
    expect(thinkingLevelsFor(agent("claude-opus-5-5"))).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    expect(thinkingLevelsFor(agent("claude-haiku-4-5"))).toEqual([]);
  });

  it("reads a typed level by its name in the app or its API value", () => {
    expect(resolveThinkingLevel(agent("claude-opus-5-5"), "deep")).toBe("high");
    expect(resolveThinkingLevel(agent("claude-opus-5-5"), "Max")).toBe("max");
    expect(resolveThinkingLevel(agent("claude-opus-5-5"), "quick")).toBe("low");
    expect(resolveThinkingLevel(agent("claude-opus-5-5"), "auto")).toBe("");
    expect(resolveThinkingLevel(agent("claude-opus-5-5"), "turbo")).toBeNull();
  });
});
