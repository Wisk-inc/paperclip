import { describe, expect, it } from "vitest";
import { skillAuthorLine, skillBrandAssets, skillDisplayName } from "./SkillCardIcon";

describe("skillDisplayName", () => {
  it("turns a slug into a sentence and keeps brand capitalisation", () => {
    expect(skillDisplayName("paperclip-create-agent")).toBe("Paperclip create agent");
    expect(skillDisplayName("para-memory-files")).toBe("PARA memory files");
    expect(skillDisplayName("agentmail")).toBe("AgentMail");
    expect(skillDisplayName("github-pr-review")).toBe("GitHub pr review");
  });
  it("leaves names that already have spaces alone", () => {
    expect(skillDisplayName("Weekly report")).toBe("Weekly report");
  });
});

describe("skillAuthorLine", () => {
  it("says built in for bundled skills and 'by' for everyone else", () => {
    expect(skillAuthorLine("Paperclip bundled")).toBe("Built into Automa");
    expect(skillAuthorLine("you")).toBe("by you");
  });
});

describe("skillBrandAssets", () => {
  it("finds product logos by slug or name", () => {
    expect(skillBrandAssets({ name: "slack", slug: "slack" })?.light).toBe("/brands/apps/slack.svg");
    expect(skillBrandAssets({ name: "google-sheets-sync", slug: null })?.light).toBe("/brands/apps/google-sheets.svg");
    expect(skillBrandAssets({ name: "paperclip-board", slug: "paperclip-board" })?.light).toBe("/favicon.svg");
  });
  it("returns null when there is no product behind the skill", () => {
    expect(skillBrandAssets({ name: "first-task", slug: "first-task" })).toBeNull();
  });
});
