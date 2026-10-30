// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("follows the reply live: a running clock, each model's work, and counts that move with every step", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(new Date(Date.parse(at) + 65_000));
      const live = (steps: StudioAssistantTurn["steps"], mateUsage: { inputTokens: number; outputTokens: number }): StudioAssistantTurn[] => [
        { id: "u1", role: "user", text: "Build a todo page", steps: [], provider: null, model: null, error: null, createdAt: at },
        {
          id: "a2",
          role: "assistant",
          text: "",
          steps,
          activity: "Running npm install",
          provider: "free",
          model: LEAD,
          error: null,
          createdAt: at,
          leadUsage: { inputTokens: 1200, outputTokens: 300, costUsd: 0, equivalentUsd: 0.21 },
          agents: [
            { id: "m1", name: "Gemma", provider: "free", model: MATE, role: "frontend", task: "Write index.html", status: "working", activity: "Writing index.html", steps: 1, usage: { ...mateUsage, costUsd: 0, equivalentUsd: 0.04 }, startedAt: at },
          ],
        },
      ];
      const first = live(
        [{ tool: "write_file", summary: "Gemma · Created index.html", ok: true, detail: null, agent: "m1", path: "index.html", at: new Date(Date.parse(at) + 53_000).toISOString() }],
        { inputTokens: 800, outputTokens: 200 },
      );
      await act(async () => root.render(<ThemeProvider><StudioTeamDashboard turns={first} running /></ThemeProvider>));

      const panel = container.querySelector('[data-testid="studio-stats-live"]')!;
      expect(panel.textContent).toContain("Working now");
      expect(container.querySelector('[data-testid="studio-stats-elapsed"]')!.textContent).toBe("1:05");
      expect(container.querySelector('[data-testid="studio-stats-doing"]')!.textContent).toBe("Running npm install…");
      expect(container.querySelector('[data-testid="studio-stats-live-counts"]')!.textContent).toBe("1 step · 1 file changed · 2.5k tokens");
      const workers = [...container.querySelectorAll('[data-testid="studio-stats-worker"]')];
      expect(workers).toHaveLength(2);
      expect(workers[1]!.textContent).toContain("Gemma");
      expect(workers[1]!.textContent).toContain("Working");
      expect(workers[1]!.textContent).toContain("Writing index.html…");
      expect(workers[1]!.textContent).toContain("Free · worth $0.04");
      // What the free work would have cost at paid prices, counted as it goes.
      expect(container.querySelector('[data-testid="studio-stat-would-cost"]')!.textContent).toBe("$0.25");
      expect(container.querySelector('[data-testid="studio-stat-files"]')!.textContent).toBe("1");
      expect(container.querySelector('[data-testid="studio-stats-moves"]')!.textContent).toContain("12s ago");

      // The clock keeps going on its own.
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(container.querySelector('[data-testid="studio-stats-elapsed"]')!.textContent).toBe("1:06");

      // The next step and the next token count show up straight away.
      const next = live(
        [
          ...first[1]!.steps,
          { tool: "edit_file", summary: "Edited app.js", ok: true, detail: null, path: "app.js", at: new Date(Date.parse(at) + 66_000).toISOString() },
        ],
        { inputTokens: 1800, outputTokens: 400 },
      );
      await act(async () => root.render(<ThemeProvider><StudioTeamDashboard turns={next} running /></ThemeProvider>));
      expect(container.querySelector('[data-testid="studio-stats-live-counts"]')!.textContent).toBe("2 steps · 2 files changed · 3.7k tokens");
      expect(container.querySelector('[data-testid="studio-stat-steps"]')!.textContent).toBe("2");
      expect(container.querySelector('[data-testid="studio-stats-moves"] li')!.textContent).toContain("Edited app.js");

      // Done: the live panel goes, the totals stay.
      await act(async () => root.render(<ThemeProvider><StudioTeamDashboard turns={next} running={false} /></ThemeProvider>));
      expect(container.querySelector('[data-testid="studio-stats-live"]')).toBeNull();
      expect(container.querySelector('[data-testid="studio-stat-files"]')!.textContent).toBe("2");
    } finally {
      vi.useRealTimers();
    }
  });
});
