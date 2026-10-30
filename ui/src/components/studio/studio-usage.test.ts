import { describe, expect, it } from "vitest";
import type { StudioAssistantTurn } from "@paperclipai/shared";
import { changedFiles, formatAgo, formatCostAndWorth, formatSpend, formatTokens, latestMoves, modelTotals, turnWorkers } from "./studio-usage";

const at = "2026-10-30T00:00:00.000Z";

function reply(overrides: Partial<StudioAssistantTurn>): StudioAssistantTurn {
  return { id: "a", role: "assistant", text: "", steps: [], provider: "free", model: "nvidia/nemotron-3-ultra-550b-a55b:free", error: null, createdAt: at, ...overrides };
}

describe("studio usage", () => {
  it("reads tokens and spend the way people read them", () => {
    expect([formatTokens(950), formatTokens(1200), formatTokens(34_000), formatTokens(1_500_000)]).toEqual(["950", "1.2k", "34k", "1.5M"]);
    expect(formatSpend("free", null)).toBe("Free");
    expect(formatSpend("anthropic", null)).toBeNull();
    expect(formatSpend("anthropic", 0.004)).toBe("under 1¢");
    expect(formatSpend("openai", 1.5)).toBe("$1.50");
  });

  it("splits a reply between the lead and each teammate", () => {
    const turn = reply({
      usage: { inputTokens: 300, outputTokens: 30, costUsd: 0 },
      leadUsage: { inputTokens: 100, outputTokens: 10, costUsd: 0 },
      agents: [
        { id: "m1", name: "Gemma", provider: "free", model: "google/gemma-4-31b-it:free", role: "backend", task: "", status: "done", steps: 1, usage: { inputTokens: 200, outputTokens: 20, costUsd: 0 }, startedAt: at },
      ],
    });
    expect(turnWorkers(turn).map((worker) => [worker.lead, worker.model, worker.usage?.inputTokens])).toEqual([
      [true, "nvidia/nemotron-3-ultra-550b-a55b:free", 100],
      [false, "google/gemma-4-31b-it:free", 200],
    ]);
    expect(turnWorkers(turn, { leadWorking: true })[0]!.status).toBe("working");
  });

  it("gives an older reply, saved before per-model counts, wholly to its lead", () => {
    const totals = modelTotals([
      reply({ id: "1", usage: { inputTokens: 500, outputTokens: 50, costUsd: 0 } }),
      reply({ id: "2", usage: { inputTokens: 100, outputTokens: 10, costUsd: 0 }, leadUsage: { inputTokens: 100, outputTokens: 10, costUsd: 0 } }),
      reply({ id: "3", provider: "anthropic", model: "claude-opus-5-5", usage: { inputTokens: 1000, outputTokens: 100, costUsd: null } }),
    ]);
    expect(totals.map((total) => [total.model, total.inputTokens, total.outputTokens, total.jobs, total.costUsd])).toEqual([
      ["claude-opus-5-5", 1000, 100, 1, null],
      ["nvidia/nemotron-3-ultra-550b-a55b:free", 600, 60, 2, 0],
    ]);
  });

  it("says what free work would have cost at paid prices, and keeps paid work to its cost", () => {
    expect(formatCostAndWorth({ free: true, costUsd: 0, equivalentUsd: 0.42 })).toBe("Free · worth $0.42");
    expect(formatCostAndWorth({ free: true, costUsd: 0, equivalentUsd: 0.004 })).toBe("Free · worth under 1¢");
    expect(formatCostAndWorth({ free: true, costUsd: 0 })).toBe("Free");
    expect(formatCostAndWorth({ free: false, costUsd: 0.12, equivalentUsd: 0.4 })).toBe("$0.12 · worth $0.40");
    expect(formatCostAndWorth({ free: false, costUsd: 0.37, equivalentUsd: 0.37 })).toBe("$0.37");
    expect(formatCostAndWorth({ free: false, costUsd: null, equivalentUsd: null })).toBeNull();
    const totals = modelTotals([reply({ leadUsage: { inputTokens: 100, outputTokens: 10, costUsd: 0, equivalentUsd: 0.3 } }), reply({ id: "b", leadUsage: { inputTokens: 1, outputTokens: 1, costUsd: 0, equivalentUsd: 0.2 } })]);
    expect(totals[0]!.equivalentUsd).toBeCloseTo(0.5);
  });

  it("counts the files changed (undone ones left out) and lists the newest moves first", () => {
    const turns = [
      reply({
        id: "t1",
        steps: [
          { tool: "write_file", summary: "Created index.html", ok: true, detail: null, path: "index.html" },
          { tool: "edit_file", summary: "Edited index.html", ok: true, detail: null, path: "index.html" },
          { tool: "delete_path", summary: "Deleted old.js", ok: true, detail: null, path: "old.js", undone: true },
          { tool: "think", summary: "Plan", ok: true, detail: null },
        ],
      }),
      reply({
        id: "t2",
        agents: [{ id: "m1", name: "Gemma", provider: "free", model: "google/gemma-4-31b-it:free", role: null, task: "", status: "done", steps: 1, startedAt: at }],
        steps: [{ tool: "edit_file", summary: "Gemma · Edited app.js", ok: true, detail: null, path: "app.js", agent: "m1" }],
      }),
    ];
    expect(changedFiles(turns).sort()).toEqual(["app.js", "index.html"]);
    const moves = latestMoves(turns, 3);
    expect(moves.map((move) => [move.who, move.step.summary])).toEqual([
      ["Gemma", "Gemma · Edited app.js"],
      ["Nemotron 3 Ultra 550b A55b", "Deleted old.js"],
      ["Nemotron 3 Ultra 550b A55b", "Edited index.html"],
    ]);
    const now = Date.parse(at);
    expect([formatAgo(at, now + 2_000), formatAgo(at, now + 12_000), formatAgo(at, now + 240_000), formatAgo(undefined, now)]).toEqual(["just now", "12s ago", "4m ago", null]);
  });
});
