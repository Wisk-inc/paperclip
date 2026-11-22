import { describe, expect, it } from "vitest";
import { freeModelAnswering, pickAnsweringFreeModel, type FreeModelHealthEntry, type FreeModelHealthMap } from "./free-models.js";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const entry = (fields: Partial<FreeModelHealthEntry>): FreeModelHealthEntry => ({ state: "ok", until: null, checkedAt: ago(1), ...fields });

describe("freeModelAnswering", () => {
  it("counts a model nobody has asked yet as answering", () => {
    expect(freeModelAnswering(undefined, NOW)).toBe(true);
  });

  it("is false while a model is held: at its limit, busy, or closed by its provider", () => {
    expect(freeModelAnswering(entry({ state: "daily_limit", until: ahead(300), last: "daily_limit" }), NOW)).toBe(false);
    expect(freeModelAnswering(entry({ state: "busy", until: ahead(2), last: "busy" }), NOW)).toBe(false);
    expect(freeModelAnswering(entry({ state: "withdrawn", until: ahead(60), last: "withdrawn" }), NOW)).toBe(false);
  });

  it("passes over a model for a quarter of an hour after it was busy, then offers it again", () => {
    expect(freeModelAnswering(entry({ state: "ok", last: "busy", checkedAt: ago(5) }), NOW)).toBe(false);
    expect(freeModelAnswering(entry({ state: "ok", last: "busy", checkedAt: ago(16) }), NOW)).toBe(true);
  });

  it("keeps a model closed by its provider out for the day", () => {
    expect(freeModelAnswering(entry({ state: "ok", last: "withdrawn", checkedAt: ago(600) }), NOW)).toBe(false);
  });

  it("is true for a model that answered", () => {
    expect(freeModelAnswering(entry({ last: "ok" }), NOW)).toBe(true);
  });
});

describe("pickAnsweringFreeModel", () => {
  const models = ["a", "b", "c", "d"];
  const health: FreeModelHealthMap = {
    a: entry({ state: "busy", until: ahead(3), last: "busy" }),
    c: entry({ last: "ok" }),
  };

  it("takes the first model, in the list's order, that is not refusing", () => {
    expect(pickAnsweringFreeModel(models, health, { now: NOW })).toBe("b");
    expect(pickAnsweringFreeModel(models, {}, { now: NOW })).toBe("a");
  });

  it("after a refusal, offers a model that answered before one that was never asked", () => {
    expect(pickAnsweringFreeModel(models, health, { now: NOW, proven: true })).toBe("c");
    expect(pickAnsweringFreeModel(models, { a: health.a! }, { now: NOW, proven: true })).toBe("b");
  });

  it("leaves out the model that just failed", () => {
    expect(pickAnsweringFreeModel(models, { c: health.c! }, { now: NOW, except: "a" })).toBe("b");
    expect(pickAnsweringFreeModel(models, { c: health.c! }, { now: NOW, except: "c", proven: true })).toBe("a");
  });

  it("says so when none of them can answer", () => {
    const all: FreeModelHealthMap = Object.fromEntries(models.map((model) => [model, entry({ state: "daily_limit", until: ahead(60), last: "daily_limit" })]));
    expect(pickAnsweringFreeModel(models, all, { now: NOW })).toBeNull();
  });
});
