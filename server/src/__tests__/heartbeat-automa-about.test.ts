import { describe, expect, it } from "vitest";
import { AUTOMA_ABOUT_FOR_AGENTS } from "@paperclipai/shared";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";

describe("who made Automa, in the wake prompt", () => {
  it.each([true, false])("is told once to every chat agent (includeDescription=%s)", (includeDescription) => {
    const prompt = buildPaperclipTaskMarkdown({
      issue: { id: "chat", title: "Chat", workMode: "standard", conversationAgentId: "agent" },
      includeDescription,
    });
    expect(prompt).toContain(AUTOMA_ABOUT_FOR_AGENTS);
    expect(prompt.split(AUTOMA_ABOUT_FOR_AGENTS)).toHaveLength(2);
  });

  it.each(["slack", "discord", "telegram"])("is told once to an agent chatting through %s", (externalChatProvider) => {
    for (const conversationAgentId of [null, "agent"]) {
      for (const nativeRunner of [true, false]) {
        const prompt = buildPaperclipTaskMarkdown({
          issue: { id: "chat", title: "Chat", conversationAgentId },
          externalChatProvider,
          nativeRunner,
        });
        expect(prompt.split(AUTOMA_ABOUT_FOR_AGENTS)).toHaveLength(2);
      }
    }
  });

  it("stays out of task work, where nobody is chatting", () => {
    const prompt = buildPaperclipTaskMarkdown({ issue: { id: "task", title: "Ship the release" } });
    expect(prompt).not.toContain(AUTOMA_ABOUT_FOR_AGENTS);
  });
});
