import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { currentThinkingLevel, resolveThinkingLevel, thinkingLevelPatch, thinkingLevelsFor } from "./ThinkingDepthControl";

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

describe("thinking level keys", () => {
  it("writes the key each runtime reads", () => {
    expect(thinkingLevelPatch({ adapterType: "claude_local" }, "high")).toEqual({ effort: "high" });
    expect(thinkingLevelPatch({ adapterType: "codex_local" }, "high")).toEqual({ modelReasoningEffort: "high", effort: "" });
    expect(thinkingLevelPatch({ adapterType: "pi_local" }, "low")).toEqual({ thinking: "low", effort: "" });
  });

  it("reads the runtime's own key first", () => {
    expect(currentThinkingLevel({ adapterType: "codex_local", adapterConfig: { modelReasoningEffort: "high" } } as never)).toBe("high");
    expect(currentThinkingLevel({ adapterType: "claude_local", adapterConfig: { effort: "max" } } as never)).toBe("max");
  });
});

describe("Kimi thinking levels", () => {
  it("offers levels only on Kimi's CLI engine and an effort-capable model", () => {
    expect(thinkingLevelsFor({ adapterType: "kimi_local", adapterConfig: { engine: "cli", model: "kimi-code/k3" } } as never)).toEqual(["", "low", "high", "max"]);
    expect(thinkingLevelsFor({ adapterType: "kimi_local", adapterConfig: { model: "kimi-code/k3" } } as never)).toEqual([]);
  });
});
