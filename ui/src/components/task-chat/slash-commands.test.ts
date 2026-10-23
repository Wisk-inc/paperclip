import { describe, expect, it } from "vitest";
import { chatSlashCommandOptions, parseChatSlashCommand } from "./slash-commands";

describe("parseChatSlashCommand", () => {
  it("reads modes, their aliases and the model query", () => {
    expect(parseChatSlashCommand("/plan")).toEqual({ name: "mode", mode: "planning" });
    expect(parseChatSlashCommand("/ASK ")).toEqual({ name: "mode", mode: "ask" });
    expect(parseChatSlashCommand("/build")).toEqual({ name: "mode", mode: "standard" });
    expect(parseChatSlashCommand("/model opus 4.7")).toEqual({ name: "model", query: "opus 4.7" });
    expect(parseChatSlashCommand("/models")).toEqual({ name: "model", query: "" });
    expect(parseChatSlashCommand("/?")).toEqual({ name: "help" });
    expect(parseChatSlashCommand("/usage")).toEqual({ name: "context" });
    expect(parseChatSlashCommand("/reset")).toEqual({ name: "clear" });
    expect(parseChatSlashCommand("/cancel")).toEqual({ name: "stop" });
    expect(parseChatSlashCommand("/think deep")).toEqual({ name: "think", level: "deep" });
    expect(parseChatSlashCommand("/think")).toEqual({ name: "think", level: "" });
  });

  it("leaves ordinary messages, paths and the server's own commands alone", () => {
    expect(parseChatSlashCommand("plan the launch")).toBeNull();
    expect(parseChatSlashCommand("/tmp/notes.md has it")).toBeNull();
    expect(parseChatSlashCommand("/new")).toBeNull();
    expect(parseChatSlashCommand("/goal ship it")).toBeNull();
    expect(parseChatSlashCommand("/unknown")).toBeNull();
    expect(parseChatSlashCommand("")).toBeNull();
  });
});

describe("chatSlashCommandOptions", () => {
  it("offers model, context and clear only in an agent chat", () => {
    const chat = chatSlashCommandOptions(true).map((option) => option.command);
    const task = chatSlashCommandOptions(false).map((option) => option.command);
    expect(chat).toEqual(["plan", "ask", "auto", "model", "think", "context", "stop", "clear", "skills", "help"]);
    expect(task).toEqual(["plan", "ask", "auto", "stop", "skills", "help"]);
    expect(chatSlashCommandOptions(true).every((option) => option.kind === "action" && option.id === `action:${option.command}`)).toBe(true);
  });
});

describe("slash commands with words after them", () => {
  it("sends them as messages unless the command takes an argument", () => {
    expect(parseChatSlashCommand("/ask what is 2+2?")).toBeNull();
    expect(parseChatSlashCommand("/reset my password flow is broken")).toBeNull();
    expect(parseChatSlashCommand("/stop doing that and use Postgres")).toBeNull();
    expect(parseChatSlashCommand("/plan")).toEqual({ name: "mode", mode: "planning" });
    expect(parseChatSlashCommand("/model opus")).toEqual({ name: "model", query: "opus" });
    expect(parseChatSlashCommand("/think deep")).toEqual({ name: "think", level: "deep" });
  });
});
