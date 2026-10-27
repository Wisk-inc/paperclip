import { describe, expect, it } from "vitest";
import { JAMAICA_PRIMER, MOAN_BASE_MODEL, MOAN_MODEL_ID, isMoanModel, moanPersona, moanSystemPrompt, resolveFreeModel } from "./moan.js";
import { PUTER_MODELS } from "./puter-ai.js";

describe("Moan", () => {
  it("runs on Nemotron 3 Ultra and leaves other models alone", () => {
    expect(MOAN_BASE_MODEL).toBe(PUTER_MODELS["nemotron-ultra"]);
    expect(resolveFreeModel(MOAN_MODEL_ID)).toEqual({ puterModel: PUTER_MODELS["nemotron-ultra"], persona: "moan" });
    expect(resolveFreeModel(" Moan/Moan-1:FREE ")).toEqual({ puterModel: PUTER_MODELS["nemotron-ultra"], persona: "moan" });
    expect(resolveFreeModel(PUTER_MODELS["deepseek-flash"])).toEqual({ puterModel: PUTER_MODELS["deepseek-flash"], persona: null });
    expect(isMoanModel("moan/moan-1:free")).toBe(true);
    expect(isMoanModel("nvidia/nemotron-3-ultra-550b-a55b:free")).toBe(false);
    expect(isMoanModel(null)).toBe(false);
  });

  it("speaks Patois first, switches for formal work, and carries the primer", () => {
    const prompt = moanSystemPrompt({});
    expect(prompt).toContain("You are Moan");
    expect(prompt).toContain("Jamaican Patois is your default");
    expect(prompt).toContain("Switch to Standard Jamaican English when the person asks");
    expect(prompt).toContain("inside code");
    expect(prompt).toContain(JAMAICA_PRIMER);
    expect(prompt).not.toContain("Retrieved from Jamaican sources");
    // The primer covers the ground Moan is asked about.
    for (const fact of ["6 August 1962", "Morant Bay", "Charter of Fundamental Rights and Freedoms", "Parish Courts", "Dangerous Drugs Act", "Road Traffic Act 2018", "fourteen parishes", "unu", "wah gwaan", "Melissa"]) {
      expect(JAMAICA_PRIMER).toContain(fact);
    }
  });

  it("names the agent when Moan runs under another name, and keeps it plain when the agent is Moan", () => {
    expect(moanPersona("Jamrs")).toContain("You are Jamrs (Moan)");
    expect(moanPersona("moan")).toContain("You are Moan,");
    expect(moanPersona()).toContain("You are Moan,");
  });

  it("puts retrieved passages between the persona and the primer, with their freshness", () => {
    const prompt = moanSystemPrompt({ knowledge: "- [JIS] Budget tabled (2026-03-10) https://jis.gov.jm/x\n  The minister...", freshness: "1,204 pages from 18 Jamaican sources, refreshed 2 hours ago" });
    const persona = prompt.indexOf("You are Moan");
    const retrieved = prompt.indexOf("# Retrieved from Jamaican sources for this turn (1,204 pages");
    const primer = prompt.indexOf("# Jamaica: the primer Moan carries");
    expect(persona).toBeGreaterThanOrEqual(0);
    expect(retrieved).toBeGreaterThan(persona);
    expect(primer).toBeGreaterThan(retrieved);
    expect(prompt).toContain("https://jis.gov.jm/x");
    expect(moanSystemPrompt({ freshness: "no pages yet" })).toContain("# Jamaican knowledge index: no pages yet");
  });
});
