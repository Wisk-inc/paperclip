import { describe, expect, it } from "vitest";
import { defaultCreateValues } from "../../components/agent-config-defaults";
import { freeModelsUIAdapter } from "./index";

describe("free models: the config saved at hire", () => {
  it("keeps the thinking level chosen, where the engine reads it", () => {
    expect(freeModelsUIAdapter.buildAdapterConfig({ ...defaultCreateValues, model: "deepseek-v3", thinkingEffort: "high" })).toEqual({
      model: "deepseek-v3",
      effort: "high",
    });
  });

  it("saves no level when none was chosen", () => {
    expect(freeModelsUIAdapter.buildAdapterConfig({ ...defaultCreateValues, model: "deepseek-v3", thinkingEffort: "" })).toEqual({ model: "deepseek-v3" });
  });
});
