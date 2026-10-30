import { describe, expect, it } from "vitest";
import { STUDIO_TEAM_LEAD_ID, type StudioTeamAgent, type StudioTeamMessage } from "@paperclipai/shared";
import { formatTeamNews, formatTeamTalk, TeamBoard, teammateLabel } from "../services/studio/team-board.js";

function mate(id: string, name: string, role: string | null): StudioTeamAgent {
  return { id, name, provider: "free", model: `${name.toLowerCase()}:free`, role, task: "", status: "working", steps: 0, startedAt: "2026-10-30T00:00:00.000Z" };
}

const agents = [mate("a", "Nemotron", "backend: the API in api.py"), mate("b", "Gemma", "frontend: the page")];

function board() {
  const messages: StudioTeamMessage[] = [];
  const created = new TeamBoard(messages, { name: "Lead", model: "lead" }, () => agents);
  for (const agent of agents) created.join(agent.id);
  return { messages, board: created };
}

describe("Studio team board", () => {
  it("names a teammate by its model and the start of its role", () => {
    expect(teammateLabel("Nemotron", "backend: the API in api.py")).toBe("Nemotron (backend)");
    expect(teammateLabel("Gemma", null)).toBe("Gemma");
  });

  it("delivers a message to the teammate it names, once, with that teammate's next tool result", () => {
    const { board: team } = board();
    const target = team.resolve("frontend", "a");
    expect(target).toEqual({ id: "b", known: true });
    team.post({ from: "a", to: target.id, kind: "message", text: "The API is at /api/todos" });

    expect(team.takeUnread("a")).toEqual([]);
    const news = formatTeamNews(team.takeUnread("b"), "b");
    expect(news).toBe("[Team chat: new messages]\n- Nemotron (backend) → you: The API is at /api/todos");
    expect(team.takeUnread("b")).toEqual([]);
  });

  it("sends to everyone when no teammate has the name, and reaches the lead by name", () => {
    const { board: team } = board();
    expect(team.resolve("database", "a")).toEqual({ id: null, known: false });
    expect(team.resolve(undefined, "a")).toEqual({ id: null, known: true });
    expect(team.resolve("lead", "a")).toEqual({ id: STUDIO_TEAM_LEAD_ID, known: true });

    const sent = team.post({ from: "b", to: null, kind: "message", text: "Using port $PORT" });
    expect(sent.toName).toBeNull();
    expect(formatTeamNews(team.takeUnread("a"), "a")).toContain("Gemma (frontend) → everyone: Using port $PORT");
  });

  it("tells teammates when another finished, but keeps the lead's tasks to itself", () => {
    const { board: team } = board();
    team.post({ from: STUDIO_TEAM_LEAD_ID, to: "b", kind: "task", text: "Write index.html" });
    team.post({ from: "b", to: STUDIO_TEAM_LEAD_ID, kind: "report", text: "index.html is written." });
    // A report goes to the lead; the other teammates only see it if it was to everyone.
    expect(team.takeUnread("a")).toEqual([]);
    team.post({ from: "b", to: null, kind: "report", text: "Done with the page." });
    expect(formatTeamNews(team.takeUnread("a"), "a")).toContain("Gemma (frontend) → everyone: finished. Done with the page.");
  });

  it("fills up after 100 messages a reply, while tasks and reports still fit", () => {
    const { board: team } = board();
    for (let index = 0; index < 99; index += 1) team.post({ from: "a", to: null, kind: "message", text: `note ${index}` });
    team.post({ from: STUDIO_TEAM_LEAD_ID, to: "b", kind: "task", text: "Write index.html" });
    expect(team.full).toBe(false);
    team.post({ from: "a", to: null, kind: "message", text: "note 99" });
    expect(team.full).toBe(true);
  });

  it("gives the lead the teammates' talk from a job, and nothing when they did not talk", () => {
    const { board: team, messages } = board();
    const start = messages.length;
    team.post({ from: STUDIO_TEAM_LEAD_ID, to: "a", kind: "task", text: "Write api.py" });
    expect(formatTeamTalk(team.talkSince(start))).toBeNull();
    team.post({ from: "a", to: "b", kind: "message", text: "Fetch /api/todos" });
    expect(formatTeamTalk(team.talkSince(start))).toBe("## What the teammates told each other\n- Nemotron (backend) → Gemma (frontend): Fetch /api/todos");
    expect(messages.map((message) => message.kind)).toEqual(["task", "message"]);
    expect(messages[0]).toMatchObject({ fromName: "Lead (lead)", fromModel: "lead", toName: "Nemotron (backend)" });
  });
});
