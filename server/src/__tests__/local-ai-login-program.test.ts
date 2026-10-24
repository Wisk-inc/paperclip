import { describe, expect, it } from "vitest";
import { assertLoginProgramAvailable } from "../services/local-ai-login.js";

describe("subscription sign-in on a phone", () => {
  it("says the program is missing and what works instead", async () => {
    const original = process.env.PATH;
    process.env.PATH = "/nonexistent-automa-test";
    try {
      await expect(assertLoginProgramAvailable("anthropic", "android")).rejects.toThrow(/Claude Code \(claude\).*isn't installed on this phone.*Anthropic API key/);
      await expect(assertLoginProgramAvailable("openai", "android")).rejects.toThrow(/npm install -g @openai\/codex/);
      // Computers keep the terminal sign-in as it is.
      await expect(assertLoginProgramAvailable("anthropic", "linux")).resolves.toBeUndefined();
    } finally {
      process.env.PATH = original;
    }
  });

  it("lets the sign-in start when the program is installed", async () => {
    await expect(assertLoginProgramAvailable("unknown-provider", "android")).resolves.toBeUndefined();
  });
});
