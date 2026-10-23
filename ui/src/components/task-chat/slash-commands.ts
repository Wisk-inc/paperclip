import type { IssueWorkMode } from "@paperclipai/shared";
import type { ActionCommandOption } from "@/context/EditorAutocompleteContext";

/**
 * Slash commands for the chat composer, in the spirit of a terminal
 * assistant: typing "/" lists them, Enter runs the one you picked. The
 * composer handles modes, stop and clear itself; the rest is handed to the
 * page that owns the conversation (the model picker, the context and help
 * sheets, the Skills page). `/new` and `/goal` already exist and stay as
 * they are: `/new` is understood by the server, `/goal` by the composer.
 */
export type ChatSlashCommand =
  | { name: "mode"; mode: IssueWorkMode }
  | { name: "model"; query: string }
  | { name: "think"; level: string }
  | { name: "context" }
  | { name: "help" }
  | { name: "skills" }
  | { name: "stop" }
  | { name: "clear" };

interface ChatSlashCommandSpec {
  command: string;
  name: string;
  description: string;
  aliases: string[];
  /** Only offered in an agent chat, never on a task. */
  conversationOnly?: boolean;
  /** The text shown in the help sheet's example column. */
  example?: string;
}

export const CHAT_SLASH_COMMANDS: readonly ChatSlashCommandSpec[] = [
  { command: "plan", name: "Plan mode", description: "Plan first; nothing runs until you say so.", aliases: ["plan", "planning"] },
  { command: "ask", name: "Ask mode", description: "Questions and answers only; no changes.", aliases: ["ask", "question"] },
  { command: "auto", name: "Auto mode", description: "Work and act without asking first.", aliases: ["auto", "build", "standard"] },
  { command: "model", name: "Model", description: "Switch the model this agent answers with.", aliases: ["model", "models"], conversationOnly: true, example: "/model opus" },
  { command: "think", name: "Thinking", description: "How long it thinks first: quick, balanced, deep, max.", aliases: ["think", "thinking", "effort"], conversationOnly: true, example: "/think deep" },
  { command: "context", name: "Context", description: "Model, mode, and how much this chat has used.", aliases: ["context", "usage", "tokens"], conversationOnly: true },
  { command: "stop", name: "Stop", description: "Interrupt the run in progress.", aliases: ["stop", "cancel", "interrupt"] },
  { command: "clear", name: "Clear", description: "Start a fresh session; history stays visible.", aliases: ["clear", "reset"], conversationOnly: true },
  { command: "skills", name: "Skills", description: "Browse the skills your agents can use.", aliases: ["skills", "skill"] },
  { command: "help", name: "Help", description: "Every slash command, in one place.", aliases: ["help", "commands", "?"] },
];

/** The composer's autocomplete entries for these commands. */
export function chatSlashCommandOptions(conversationMode: boolean): ActionCommandOption[] {
  return CHAT_SLASH_COMMANDS.filter((spec) => conversationMode || !spec.conversationOnly).map((spec) => ({
    id: `action:${spec.command}`,
    kind: "action" as const,
    command: spec.command,
    name: spec.name,
    description: spec.description,
    aliases: spec.aliases,
  }));
}

const MODE_BY_COMMAND: Record<string, IssueWorkMode> = {
  plan: "planning",
  planning: "planning",
  ask: "ask",
  question: "ask",
  auto: "standard",
  build: "standard",
  standard: "standard",
};

/**
 * Parses a message that is one slash command (plus an optional argument).
 * Anything else, including prose that merely starts with a slash path like
 * "/tmp", returns null and is sent as a normal message.
 */
export function parseChatSlashCommand(body: string): ChatSlashCommand | null {
  const match = /^\/([a-z?]+)(?:[  ]+(.*))?$/isu.exec(body.trim());
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  const argument = (match[2] ?? "").trim();
  // Only /model and /think take words after them. "/ask what is 2+2?" or
  // "/reset my password flow is broken" is a message, not a command: run as a
  // command it threw the text away (and reset the session).
  const takesArgument = ["model", "models", "think", "thinking", "effort"].includes(word);
  if (argument && !takesArgument) return null;
  if (word in MODE_BY_COMMAND) return { name: "mode", mode: MODE_BY_COMMAND[word]! };
  switch (word) {
    case "model":
    case "models":
      return { name: "model", query: argument };
    case "think":
    case "thinking":
    case "effort":
      return { name: "think", level: argument };
    case "context":
    case "usage":
    case "tokens":
      return { name: "context" };
    case "help":
    case "commands":
    case "?":
      return { name: "help" };
    case "skills":
    case "skill":
      return { name: "skills" };
    case "stop":
    case "cancel":
    case "interrupt":
      return { name: "stop" };
    case "clear":
    case "reset":
      return { name: "clear" };
    default:
      return null;
  }
}
