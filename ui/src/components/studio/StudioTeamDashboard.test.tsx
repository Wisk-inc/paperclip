// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StudioAssistantTurn } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import { StudioTeamDashboard } from "./StudioTeamDashboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = "2026-10-30T00:00:00.000Z";
const LEAD = "nvidia/nemotron-3-ultra-550b-a55b:free";
const MATE = "google/gemma-4-31b-it:free";

describe("StudioTeamDashboard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("says what it will show before anything ran", async () => {
    await act(async () => root.render(<StudioTeamDashboard turns={[]} />));
    expect(container.querySelector('[data-testid="studio-team-dashboard-empty"]')).not.toBeNull();
  });

  it("lists each model's tokens, most first, and what the team said", async () => {
    const turns: StudioAssistantTurn[] = [
      {
        id: "a1",
        role: "assistant",
        text: "Done",
        steps: [],
        provider: "free",
        model: LEAD,
        error: null,
        createdAt: at,
        usage: { inputTokens: 3000, outputTokens: 600, costUsd: 0 },
        leadUsage: { inputTokens: 1000, outputTokens: 100, costUsd: 0 },
        agents: [{ id: "m1", name: "Gemma", provider: "free", model: MATE, role: "backend", task: "Write api.py", status: "done", steps: 3, usage: { inputTokens: 2000, outputTokens: 500, costUsd: 0 }, startedAt: at }],
        teamChat: [
          { id: "c1", from: "lead", fromName: "Nemotron (lead)", fromModel: LEAD, to: "m1", toName: "Gemma (backend)", kind: "task", text: "Write api.py", createdAt: at },
          { id: "c2", from: "m1", fromName: "Gemma (backend)", fromModel: MATE, to: null, toName: null, kind: "message", text: "The API is at /api/todos", createdAt: at },
        ],
      },
    ];
    await act(async () => root.render(<ThemeProvider><StudioTeamDashboard turns={turns} /></ThemeProvider>));

    const stats = container.querySelector("dl")!;
    expect(stats.textContent).toContain("Models2");
    expect(stats.textContent).toContain("Tokens3.6k");
    expect(stats.textContent).toContain("CostFree");
    const rows = [...container.querySelectorAll('[data-testid="studio-dashboard-model"]')];
    expect(rows.map((row) => row.textContent?.includes("2.0k in"))).toEqual([true, false]);
    expect(rows[1]!.textContent).toContain("1.0k in · 100 out · 1 job");
    const chat = container.querySelector('[data-testid="studio-dashboard-chat"]')!;
    expect(chat.textContent).toContain("The API is at /api/todos");
    expect(chat.textContent).toContain("everyone");
  });
});
