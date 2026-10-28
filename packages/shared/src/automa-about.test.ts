import { describe, expect, it } from "vitest";
import { AUTOMA_ABOUT_FOR_AGENTS, AUTOMA_CREDIT } from "./automa-about.js";

describe("who made Automa", () => {
  it("credits Nathan Lyttle with the app, in Jamaica", () => {
    expect(AUTOMA_CREDIT).toBe("By Nathan Lyttle · Corx Labs · Made in Jamaica 🇯🇲");
    expect(AUTOMA_ABOUT_FOR_AGENTS).toContain("Automa was made in Jamaica by Nathan Lyttle (Corx Labs).");
  });

  it("tells agents to say it when asked, not unprompted, and never to credit him with the model", () => {
    expect(AUTOMA_ABOUT_FOR_AGENTS).toContain("When someone asks who made Automa or this app, or where it comes from, say so; don't bring it up otherwise.");
    expect(AUTOMA_ABOUT_FOR_AGENTS).toContain("The AI model you run on was made by its own maker, not by Nathan Lyttle.");
  });
});
