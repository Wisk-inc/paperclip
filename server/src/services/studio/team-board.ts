import { randomUUID } from "node:crypto";
import { STUDIO_TEAM_LEAD_ID, type StudioTeamAgent, type StudioTeamMessage } from "@paperclipai/shared";

/** At most this many new lines reach a teammate with one tool result. */
const MAX_DELIVERED = 12;
/** Teammates' messages kept per reply: the whole turn, chat included, goes out live on every step. */
const MAX_MESSAGES = 100;
const MAX_LINE_CHARS = 1500;
/** Another teammate's finished report, as the others see it: the start only. */
const REPORT_PREVIEW_CHARS = 600;
const EVERYONE = new Set(["everyone", "everybody", "all", "team", "the team"]);
const LEAD_WORDS = new Set(["lead", "the lead", "leader"]);

function clipLine(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** How a teammate is named in the chat and in step summaries: its model, and the start of its role. */
export function teammateLabel(name: string, role: string | null | undefined): string {
  const short = role ? role.split(/[:,—-]/)[0]!.trim().slice(0, 40) : "";
  return short ? `${name} (${short})` : name;
}

/**
 * The team chat for one reply: the lead's assignments, what teammates tell
 * each other while they work, and their reports. A teammate gets the lines
 * meant for it with its next tool result, so teammates working at the same
 * time can agree on file names, APIs and ports instead of guessing.
 */
export class TeamBoard {
  private readonly seen = new Map<string, number>();

  constructor(
    /** The turn's own list: lines appear in the transcript as they are posted. */
    readonly messages: StudioTeamMessage[],
    private readonly lead: { name: string; model: string },
    private readonly agents: () => StudioTeamAgent[],
    private readonly onChange: () => void = () => undefined,
  ) {}

  private who(id: string): { name: string; model: string } {
    if (id === STUDIO_TEAM_LEAD_ID) return { name: `${this.lead.name} (lead)`, model: this.lead.model };
    const agent = this.agents().find((candidate) => candidate.id === id);
    return agent ? { name: teammateLabel(agent.name, agent.role), model: agent.model } : { name: "A teammate", model: "" };
  }

  /** Who `to` names: a teammate (by name or role), the lead, or everyone (null). `known` is false for a name no one has. */
  resolve(to: string | null | undefined, fromId: string): { id: string | null; known: boolean } {
    const wanted = (to ?? "").trim().toLowerCase();
    if (!wanted || EVERYONE.has(wanted)) return { id: null, known: true };
    if (LEAD_WORDS.has(wanted) || wanted === this.lead.name.toLowerCase()) return { id: STUDIO_TEAM_LEAD_ID, known: true };
    const others = this.agents().filter((agent) => agent.id !== fromId);
    const match = others.find((agent) => teammateLabel(agent.name, agent.role).toLowerCase() === wanted)
      ?? others.find((agent) => (agent.role ?? "").toLowerCase().startsWith(wanted))
      ?? others.find((agent) => agent.name.toLowerCase() === wanted)
      ?? others.find((agent) => agent.name.toLowerCase().includes(wanted) || (agent.role ?? "").toLowerCase().includes(wanted));
    return match ? { id: match.id, known: true } : { id: null, known: false };
  }

  post(input: { from: string; to: string | null; kind: StudioTeamMessage["kind"]; text: string }): StudioTeamMessage {
    const from = this.who(input.from);
    const message: StudioTeamMessage = {
      id: randomUUID(),
      from: input.from,
      fromName: from.name,
      fromModel: from.model,
      to: input.to,
      toName: input.to === null ? null : this.who(input.to).name,
      kind: input.kind,
      text: input.text.trim(),
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    this.onChange();
    return message;
  }

  /** No room for more teammate messages in this reply (tasks and reports always fit). */
  get full(): boolean {
    return this.messages.filter((message) => message.kind === "message").length >= MAX_MESSAGES;
  }

  /** A teammate starts reading the chat from here (its own task is in its prompt). */
  join(agentId: string) {
    this.seen.set(agentId, this.messages.length);
  }

  /** The lines for this teammate since it last looked: from the others, to it or to everyone. */
  takeUnread(agentId: string): StudioTeamMessage[] {
    const from = this.seen.get(agentId) ?? this.messages.length;
    this.seen.set(agentId, this.messages.length);
    return this.messages
      .slice(from)
      .filter((message) => message.from !== agentId && (message.kind === "message" || message.kind === "report") && (message.to === null || message.to === agentId));
  }

  /** What the teammates told each other since a point in the chat. */
  talkSince(index: number): StudioTeamMessage[] {
    return this.messages.slice(index).filter((message) => message.kind === "message");
  }
}

function line(message: StudioTeamMessage, forId: string | null): string {
  const to = message.to !== null && message.to === forId ? "you" : (message.toName ?? "everyone");
  const text = message.kind === "report" ? `finished. ${clipLine(message.text, REPORT_PREVIEW_CHARS)}` : clipLine(message.text, MAX_LINE_CHARS);
  return `- ${message.fromName} → ${to}: ${text}`;
}

/** New lines for a teammate, to append to its tool result; null when there are none. */
export function formatTeamNews(messages: StudioTeamMessage[], forId: string): string | null {
  if (!messages.length) return null;
  const shown = messages.slice(-MAX_DELIVERED);
  const older = messages.length - shown.length;
  return [`[Team chat: new messages${older ? ` (${older} older not shown)` : ""}]`, ...shown.map((message) => line(message, forId))].join("\n");
}

/** The teammates' talk during a job, for the lead's view of the results; null when they said nothing to each other. */
export function formatTeamTalk(messages: StudioTeamMessage[]): string | null {
  if (!messages.length) return null;
  const shown = messages.slice(-40);
  return ["## What the teammates told each other", ...shown.map((message) => line(message, STUDIO_TEAM_LEAD_ID))].join("\n");
}
