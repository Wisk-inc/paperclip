import { describe, expect, it } from "vitest";
import type { OrgNode } from "@/api/agents";
import { canReportTo, cardAt, descendantIds, parsePositions } from "./org-chart-editing";

const node = (id: string, reports: OrgNode[] = []): OrgNode => ({ id, name: id, role: "general", status: "idle", reports }) as OrgNode;
const tree = [node("ada", [node("bo", [node("cy")]), node("di")]), node("ed")];

describe("org chart editing", () => {
  it("finds everyone below an agent", () => {
    expect([...descendantIds(tree, "ada")].sort()).toEqual(["bo", "cy", "di"]);
    expect([...descendantIds(tree, "cy")]).toEqual([]);
  });

  it("refuses reporting lines that would loop", () => {
    expect(canReportTo(tree, "ada", "cy")).toBe(false);
    expect(canReportTo(tree, "bo", "bo")).toBe(false);
    expect(canReportTo(tree, "cy", "di")).toBe(true);
    expect(canReportTo(tree, "ed", "cy")).toBe(true);
  });

  it("finds the card under a point, skipping the one being dragged", () => {
    const cards = [{ id: "ada", x: 0, y: 0 }, { id: "bo", x: 250, y: 0 }];
    const size = { width: 200, height: 100 };
    expect(cardAt(cards, { x: 260, y: 50 }, size, "ada")).toBe("bo");
    expect(cardAt(cards, { x: 10, y: 10 }, size, "ada")).toBeNull();
    expect(cardAt(cards, { x: 225, y: 50 }, size, "x")).toBeNull();
  });

  it("reads only valid saved positions", () => {
    expect(parsePositions('{"a":{"x":1,"y":2},"b":{"x":"no"},"c":null}')).toEqual({ a: { x: 1, y: 2 } });
    expect(parsePositions("not json")).toEqual({});
  });
});
