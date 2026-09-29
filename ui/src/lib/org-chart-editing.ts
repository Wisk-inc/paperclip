import { useCallback, useSyncExternalStore } from "react";
import type { OrgNode } from "@/api/agents";

/**
 * Editing the org chart by hand: drag a card onto another to change who it
 * reports to, or onto empty space to place it. Placed positions are kept on
 * this device, per organization; reporting lines are saved on the server.
 */
export interface ChartPoint {
  x: number;
  y: number;
}

/** Everyone below `id` in the tree (its reports, their reports, and so on). */
export function descendantIds(tree: OrgNode[], id: string): Set<string> {
  const below = new Set<string>();
  const find = (nodes: OrgNode[]): OrgNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = find(node.reports);
      if (found) return found;
    }
    return null;
  };
  const collect = (node: OrgNode) => {
    for (const child of node.reports) {
      below.add(child.id);
      collect(child);
    }
  };
  const start = find(tree);
  if (start) collect(start);
  return below;
}

/** Whether `agentId` may report to `managerId`: not itself, and not someone in its own team (a loop). */
export function canReportTo(tree: OrgNode[], agentId: string, managerId: string): boolean {
  return agentId !== managerId && !descendantIds(tree, agentId).has(managerId);
}

/** The card under `point` (chart coordinates), skipping `excludeId`. Later cards win, as they paint on top. */
export function cardAt(
  cards: Array<{ id: string; x: number; y: number }>,
  point: ChartPoint,
  size: { width: number; height: number },
  excludeId: string,
): string | null {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const card = cards[index]!;
    if (card.id === excludeId) continue;
    if (point.x >= card.x && point.x <= card.x + size.width && point.y >= card.y && point.y <= card.y + size.height) return card.id;
  }
  return null;
}

const EVENT = "automa:org-chart-positions";
const memory = new Map<string, string>();
const storageKey = (companyId: string) => `automa.orgChartPositions:${companyId}`;

export function parsePositions(raw: string): Record<string, ChartPoint> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const positions: Record<string, ChartPoint> = {};
    for (const [id, point] of Object.entries(value as Record<string, unknown>)) {
      const candidate = point as Partial<ChartPoint> | null;
      if (candidate && Number.isFinite(candidate.x) && Number.isFinite(candidate.y)) positions[id] = { x: candidate.x!, y: candidate.y! };
    }
    return positions;
  } catch {
    return {};
  }
}

function read(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? "{}";
  } catch {
    return memory.get(key) ?? "{}";
  }
}

function write(key: string, positions: Record<string, ChartPoint>) {
  const value = JSON.stringify(positions);
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Placement still works for this session without storage.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/** Cards you placed by hand in this organization's chart. */
export function useOrgChartPositions(companyId: string | null | undefined) {
  const key = storageKey(companyId ?? "none");
  const raw = useSyncExternalStore(subscribe, useCallback(() => read(key), [key]), () => "{}");
  const positions = parsePositions(raw);
  const place = useCallback((id: string, point: ChartPoint | null) => {
    const next = parsePositions(read(key));
    if (point) next[id] = { x: Math.round(point.x), y: Math.round(point.y) };
    else delete next[id];
    write(key, next);
  }, [key]);
  const reset = useCallback(() => write(key, {}), [key]);
  return { positions, place, reset };
}
