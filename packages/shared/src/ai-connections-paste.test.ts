import { describe, expect, it } from "vitest";
import { cleanPastedApiKey, createAiConnectionSchema } from "./ai-connections.js";
import { saveStudioAiKeySchema } from "./studio/types.js";

describe("pasted API keys", () => {
  it("drops invisible characters and spaces a copied key picks up", () => {
    expect(cleanPastedApiKey(" sk-ant-abc​123﻿ \n")).toBe("sk-ant-abc123");
  });

  it("stores the cleaned key", () => {
    const parsed = createAiConnectionSchema.parse({
      provider: "anthropic",
      method: "api_key",
      name: "Anthropic key",
      ownership: "personal",
      apiKey: "sk-ant-H14-fake​",
    });
    expect(parsed.apiKey).toBe("sk-ant-H14-fake");
    expect(saveStudioAiKeySchema.parse({ provider: "anthropic", apiKey: "sk-ant-studio\u200B" }).apiKey).toBe("sk-ant-studio");
  });
});
