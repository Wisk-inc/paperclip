import { AgentAvatar } from "@/components/AgentAvatar";
import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, cn } from "../lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ArrowUpToLine, Download, Maximize2, Minus, Network, Plus, RotateCcw, Upload } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { canReportTo, cardAt, useOrgChartPositions, type ChartPoint } from "@/lib/org-chart-editing";

// Layout constants
const CARD_W = 200;
const CARD_H = 100;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;
/** Touch: hold this long to pick a card up (a quick swipe still pans). */
const LONG_PRESS_MS = 350;
/** Mouse: move this far to start dragging a card. */
const MOUSE_DRAG_THRESHOLD = 4;
/** Touch: moving farther than this before the long press lands means "pan". */
const TOUCH_SLOP = 8;
/** The strip at the top of the chart that makes a dropped agent report to nobody. */
const TOP_ZONE_PX = 56;

interface CardDrag {
  id: string;
  x: number;
  y: number;
  /** A manager the card may report to, under the pointer. */
  target: string | null;
  /** A card under the pointer it may not report to (it is in its own team). */
  blocked: string | null;
  /** Over the "top of the org" strip. */
  top: boolean;
}

interface CardPress {
  id: string;
  pointerId: number;
  pointerType: string;
  element: HTMLElement;
  client: ChartPoint;
  origin: ChartPoint;
  timer: number | null;
  active: boolean;
}
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const FIT_PADDING = 40;
const TOUCH_MOVE_THRESHOLD = 6;

// ── Tree layout types ───────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  children: LayoutNode[];
}

interface Point {
  x: number;
  y: number;
}

interface TouchGesture {
  mode: "pan" | "pinch" | null;
  startPoint: Point;
  startPan: Point;
  startZoom: number;
  startDistance: number;
  startCenter: Point;
  moved: boolean;
}

// ── Layout algorithm ────────────────────────────────────────────────────

/** Compute the width each subtree needs. */
function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

/** Recursively assign x,y positions. */
function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;

    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }

  return {
    id: node.id,
    name: node.name,
    role: node.role,
    status: node.status,
    x: x + (totalW - CARD_W) / 2,
    y,
    children: layoutChildren,
  };
}

/** Layout all root nodes side by side. */
function layoutForest(roots: OrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];

  const totalW = roots.reduce((sum, r) => sum + subtreeWidth(r), 0);
  const gaps = (roots.length - 1) * GAP_X;
  let x = PADDING;
  const y = PADDING;

  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y));
    x += w + GAP_X;
  }

  // Compute bounds and return
  return result;
}

/** Flatten layout tree to list of nodes. */
function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

/** Collect all parent→child edges. */
function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(n: LayoutNode) {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  }
  nodes.forEach(walk);
  return edges;
}

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

function fitChartToViewport(
  containerWidth: number,
  containerHeight: number,
  bounds: { width: number; height: number },
): { zoom: number; pan: Point } | null {
  if (containerWidth <= FIT_PADDING || containerHeight <= FIT_PADDING) return null;

  const scaleX = (containerWidth - FIT_PADDING) / bounds.width;
  const scaleY = (containerHeight - FIT_PADDING) / bounds.height;
  const zoom = clampZoom(Math.min(scaleX, scaleY, 1));
  const chartWidth = bounds.width * zoom;
  const chartHeight = bounds.height * zoom;

  return {
    zoom,
    pan: {
      x: (containerWidth - chartWidth) / 2,
      y: (containerHeight - chartHeight) / 2,
    },
  };
}

function touchPoint(touch: React.Touch): Point {
  return { x: touch.clientX, y: touch.clientY };
}

function touchDistance(a: React.Touch, b: React.Touch): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function touchCenter(a: React.Touch, b: React.Touch, container: HTMLDivElement): Point {
  const rect = container.getBoundingClientRect();
  return {
    x: (a.clientX + b.clientX) / 2 - rect.left,
    y: (a.clientY + b.clientY) / 2 - rect.top,
  };
}

// ── Status dot colors (raw hex for SVG) ─────────────────────────────────

import { getAdapterLabel } from "../adapters/adapter-display-registry";

const statusDotColor: Record<string, string> = {
  running: "var(--hex-22d3ee)",
  active: "var(--hex-4ade80)",
  paused: "var(--hex-facc15)",
  idle: "var(--hex-facc15)",
  error: "var(--hex-f87171)",
  terminated: "var(--hex-a3a3a3)",
};
const defaultDotColor = "var(--hex-a3a3a3)";

// ── Main component ──────────────────────────────────────────────────────

export interface OrgChartProps {
  /** Pre-filtered tree for embedding the chart in another collection page. */
  orgTree?: OrgNode[];
  /** Agent records paired with a pre-filtered embedded tree. */
  agents?: Agent[];
  /** Hides page-level actions and breadcrumb ownership. */
  embedded?: boolean;
  /** Extra classes on the chart root (for example, hiding it on phones where the org tree shows instead). */
  className?: string;
}

export function OrgChart({ orgTree: providedOrgTree, agents: providedAgents, embedded = false, className }: OrgChartProps = {}) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  // Import is floored server-side on cloud-managed instances (403 cloud_managed), so the
  // button is hidden rather than dead-ending. Export stays available. Both
  // buttons also respect the operator-hidden settings registry.
  const isCloud = Boolean(useCloudInstance());
  const { hidden: hiddenSettings } = useHiddenSettings();
  const showImport = !isCloud && !hiddenSettings.has("company.import");
  const showExport = !hiddenSettings.has("company.export");

  const { data: queriedOrgTree, isLoading } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && providedOrgTree === undefined,
  });

  const { data: queriedAgents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && providedAgents === undefined,
  });
  const orgTree = providedOrgTree ?? queriedOrgTree;
  const agents = providedAgents ?? queriedAgents;

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  useEffect(() => {
    if (!embedded) setBreadcrumbs([{ label: "Org Chart" }]);
  }, [embedded, setBreadcrumbs]);

  // Layout computation
  const layout = useMemo(() => layoutForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  // Cards you placed by hand, and the one you are dragging now.
  const { positions, place, reset: resetPositions } = useOrgChartPositions(selectedCompanyId);
  const [cardDrag, setCardDrag] = useState<CardDrag | null>(null);
  const cardDragRef = useRef<CardDrag | null>(null);
  const cardPress = useRef<CardPress | null>(null);
  const updateCardDrag = useCallback((next: CardDrag | null) => {
    cardDragRef.current = next;
    setCardDrag(next);
  }, []);
  const positionOf = useCallback(
    (node: LayoutNode): ChartPoint =>
      cardDrag?.id === node.id ? { x: cardDrag.x, y: cardDrag.y } : positions[node.id] ?? { x: node.x, y: node.y },
    [cardDrag, positions],
  );
  const placedCount = allNodes.filter((node) => positions[node.id]).length;

  // Compute SVG bounds
  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) {
      const at = positions[n.id] ?? n;
      maxX = Math.max(maxX, at.x + CARD_W);
      maxY = Math.max(maxY, at.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes, positions]);

  // Pan & zoom state
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const touchGesture = useRef<TouchGesture>({
    mode: null,
    startPoint: { x: 0, y: 0 },
    startPan: { x: 0, y: 0 },
    startZoom: 1,
    startDistance: 0,
    startCenter: { x: 0, y: 0 },
    moved: false,
  });
  const suppressNextCardClick = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
    };
  }, []);

  // Center the chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    hasInitialized.current = false;
  }, [orgTree]);

  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    const container = containerRef.current;
    const fitted = fitChartToViewport(container.clientWidth, container.clientHeight, bounds);
    if (!fitted) return;

    hasInitialized.current = true;
    setZoom(fitted.zoom);
    setPan(fitted.pan);
  }, [allNodes, bounds]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Don't drag if clicking a card
    const target = e.target as HTMLElement;
    if (target.closest("[data-org-card]")) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = clampZoom(zoom * factor);

    // Zoom toward mouse position
    const scale = newZoom / zoom;
    setPan({
      x: mouseX - scale * (mouseX - pan.x),
      y: mouseY - scale * (mouseY - pan.y),
    });
    setZoom(newZoom);
  }, [zoom, pan]);

  const zoomTowardPoint = useCallback((newZoom: number, point: Point) => {
    const clampedZoom = clampZoom(newZoom);
    const scale = clampedZoom / zoom;
    setPan({
      x: point.x - scale * (point.x - pan.x),
      y: point.y - scale * (point.y - pan.y),
    });
    setZoom(clampedZoom);
  }, [zoom, pan]);

  const fitToScreen = useCallback(() => {
    if (!containerRef.current) return;
    const fitted = fitChartToViewport(
      containerRef.current.clientWidth,
      containerRef.current.clientHeight,
      bounds,
    );
    if (!fitted) return;

    setZoom(fitted.zoom);
    setPan(fitted.pan);
  }, [bounds]);

  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const setManager = useMutation({
    mutationFn: ({ agentId, reportsTo }: { agentId: string; reportsTo: string | null; previous: string | null; undo?: boolean }) =>
      agentsApi.update(agentId, { reportsTo }, selectedCompanyId ?? undefined),
    onSuccess: async (_updated, { agentId, reportsTo, previous, undo }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.org(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) }),
      ]);
      if (undo) return;
      haptic("success");
      const name = agentMap.get(agentId)?.name ?? "The agent";
      const manager = reportsTo ? agentMap.get(reportsTo)?.name ?? "their new manager" : null;
      pushToast({
        title: manager ? `${name} now reports to ${manager}` : `${name} is now at the top of the org`,
        tone: "success",
        action: { label: "Undo", onClick: () => setManager.mutate({ agentId, reportsTo: previous, previous: reportsTo, undo: true }) },
      });
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn’t change the reporting line", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  const suppressCardClick = useCallback(() => {
    suppressNextCardClick.current = true;
    if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressNextCardClick.current = false;
      suppressClickTimerRef.current = null;
    }, 400);
  }, []);

  const pickUp = useCallback((press: CardPress) => {
    press.active = true;
    haptic("thud");
    try {
      press.element.setPointerCapture(press.pointerId);
    } catch {
      // The pointer already ended; the drag ends with it.
    }
    updateCardDrag({ id: press.id, x: press.origin.x, y: press.origin.y, target: null, blocked: null, top: false });
  }, [updateCardDrag]);

  const handleCardPointerDown = useCallback((e: React.PointerEvent<HTMLElement>, node: LayoutNode) => {
    if (e.button !== 0) return;
    const press: CardPress = {
      id: node.id,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      element: e.currentTarget,
      client: { x: e.clientX, y: e.clientY },
      origin: positions[node.id] ?? { x: node.x, y: node.y },
      timer: null,
      active: false,
    };
    cardPress.current = press;
    if (e.pointerType !== "mouse") {
      press.timer = window.setTimeout(() => {
        if (cardPress.current === press) pickUp(press);
      }, LONG_PRESS_MS);
    }
  }, [pickUp, positions]);

  const handleCardPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const press = cardPress.current;
    const container = containerRef.current;
    if (!press || press.pointerId !== e.pointerId || !container) return;
    const dx = e.clientX - press.client.x;
    const dy = e.clientY - press.client.y;
    if (!press.active) {
      if (press.pointerType === "mouse" && Math.hypot(dx, dy) > MOUSE_DRAG_THRESHOLD) {
        pickUp(press);
      } else {
        if (press.pointerType !== "mouse" && Math.hypot(dx, dy) > TOUCH_SLOP) {
          if (press.timer !== null) window.clearTimeout(press.timer);
          cardPress.current = null;
        }
        return;
      }
    }
    e.stopPropagation();
    const rect = container.getBoundingClientRect();
    const pointer = { x: (e.clientX - rect.left - pan.x) / zoom, y: (e.clientY - rect.top - pan.y) / zoom };
    const top = e.clientY - rect.top < TOP_ZONE_PX;
    const cards = allNodes.map((node) => ({ id: node.id, ...(positions[node.id] ?? { x: node.x, y: node.y }) }));
    const over = top ? null : cardAt(cards, pointer, { width: CARD_W, height: CARD_H }, press.id);
    const allowed = over !== null && canReportTo(orgTree ?? [], press.id, over);
    updateCardDrag({
      id: press.id,
      x: press.origin.x + dx / zoom,
      y: press.origin.y + dy / zoom,
      target: allowed ? over : null,
      blocked: over !== null && !allowed ? over : null,
      top,
    });
  }, [allNodes, orgTree, pan, pickUp, positions, updateCardDrag, zoom]);

  const endCardPress = useCallback((e: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
    const press = cardPress.current;
    if (!press || press.pointerId !== e.pointerId) return;
    if (press.timer !== null) window.clearTimeout(press.timer);
    cardPress.current = null;
    if (!press.active) return;
    suppressCardClick();
    const drag = cardDragRef.current;
    updateCardDrag(null);
    if (!drag || cancelled) return;
    const previous = agentMap.get(drag.id)?.reportsTo ?? null;
    if (drag.target) {
      if (drag.target !== previous) setManager.mutate({ agentId: drag.id, reportsTo: drag.target, previous });
      place(drag.id, null);
    } else if (drag.top) {
      if (previous) setManager.mutate({ agentId: drag.id, reportsTo: null, previous });
      place(drag.id, null);
    } else if (drag.blocked) {
      haptic("warning");
      const name = agentMap.get(drag.id)?.name ?? "That agent";
      const other = agentMap.get(drag.blocked)?.name ?? "them";
      pushToast({ title: `${name} can’t report to ${other}`, body: `${other} is in ${name}’s own team.`, tone: "warn" });
    } else {
      place(drag.id, { x: Math.max(0, drag.x), y: Math.max(0, drag.y) });
    }
  }, [agentMap, place, pushToast, setManager, suppressCardClick, updateCardDrag]);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length >= 2 && containerRef.current) {
      const [first, second] = [e.touches[0]!, e.touches[1]!];
      touchGesture.current = {
        mode: "pinch",
        startPoint: { x: 0, y: 0 },
        startPan: pan,
        startZoom: zoom,
        startDistance: touchDistance(first, second),
        startCenter: touchCenter(first, second, containerRef.current),
        moved: false,
      };
      return;
    }

    const touch = e.touches[0];
    if (!touch) return;
    touchGesture.current = {
      mode: "pan",
      startPoint: touchPoint(touch),
      startPan: pan,
      startZoom: zoom,
      startDistance: 0,
      startCenter: { x: 0, y: 0 },
      moved: false,
    };
  }, [pan, zoom]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || !touchGesture.current.mode || cardPress.current?.active) return;

    if (e.touches.length >= 2) {
      const [first, second] = [e.touches[0]!, e.touches[1]!];
      const distance = touchDistance(first, second);
      const center = touchCenter(first, second, container);

      if (touchGesture.current.mode !== "pinch" || touchGesture.current.startDistance === 0) {
        touchGesture.current = {
          mode: "pinch",
          startPoint: { x: 0, y: 0 },
          startPan: pan,
          startZoom: zoom,
          startDistance: distance,
          startCenter: center,
          moved: false,
        };
        return;
      }

      const gesture = touchGesture.current;
      const nextZoom = clampZoom(gesture.startZoom * (distance / gesture.startDistance));
      const scale = nextZoom / gesture.startZoom;
      const dx = center.x - gesture.startCenter.x;
      const dy = center.y - gesture.startCenter.y;
      gesture.moved =
        gesture.moved ||
        Math.abs(distance - gesture.startDistance) > TOUCH_MOVE_THRESHOLD ||
        Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
      setZoom(nextZoom);
      setPan({
        x: center.x - scale * (gesture.startCenter.x - gesture.startPan.x),
        y: center.y - scale * (gesture.startCenter.y - gesture.startPan.y),
      });
      return;
    }

    const touch = e.touches[0];
    if (!touch || touchGesture.current.mode !== "pan") return;
    const dx = touch.clientX - touchGesture.current.startPoint.x;
    const dy = touch.clientY - touchGesture.current.startPoint.y;
    touchGesture.current.moved = touchGesture.current.moved || Math.hypot(dx, dy) > TOUCH_MOVE_THRESHOLD;
    setPan({
      x: touchGesture.current.startPan.x + dx,
      y: touchGesture.current.startPan.y + dy,
    });
  }, [pan, zoom]);

  const handleTouchEnd = useCallback(() => {
    if (touchGesture.current.moved) {
      suppressNextCardClick.current = true;
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressNextCardClick.current = false;
        suppressClickTimerRef.current = null;
      }, 400);
    }
    touchGesture.current = {
      mode: null,
      startPoint: { x: 0, y: 0 },
      startPan: pan,
      startZoom: zoom,
      startDistance: 0,
      startCenter: { x: 0, y: 0 },
      moved: false,
    };
  }, [pan, zoom]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select an organization to view the org chart." />;
  }

  if (providedOrgTree === undefined && isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (orgTree && orgTree.length === 0) {
    return <EmptyState icon={Network} message="No organizational hierarchy defined." />;
  }

  return (
    <div
      className={cn(
        embedded
          ? "flex min-h-(--sz-420px) flex-1 flex-col md:min-h-0"
          : "flex h-(--sz-calc-38) min-h-(--sz-420px) flex-col md:h-full md:min-h-0",
        className,
      )}
    >
      {!embedded && (showImport || showExport) ? (
        <div className="mb-2 flex shrink-0 flex-wrap items-center justify-start gap-2">
        {showImport ? (
          <Link to="/company/import">
            <Button variant="outline" size="sm">
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Import organization
            </Button>
          </Link>
        ) : null}
        {showExport ? (
          <Link to="/company/export">
            <Button variant="outline" size="sm">
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export organization
            </Button>
          </Link>
        ) : null}
        </div>
      ) : null}
      <div
        ref={containerRef}
        data-testid="org-chart-viewport"
        className="w-full flex-1 min-h-0 overflow-hidden relative bg-muted/20 border border-border rounded-lg"
        style={{
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
          overscrollBehavior: "contain",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {/* Zoom controls */}
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-1.5">
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              const container = containerRef.current;
              if (container) {
                zoomTowardPoint(zoom * 1.2, {
                  x: container.clientWidth / 2,
                  y: container.clientHeight / 2,
                });
              }
            }}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              const container = containerRef.current;
              if (container) {
                zoomTowardPoint(zoom * 0.8, {
                  x: container.clientWidth / 2,
                  y: container.clientHeight / 2,
                });
              }
            }}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-(length:--text-nano) transition-colors hover:bg-accent sm:size-7"
            onClick={fitToScreen}
            title="Fit to screen"
            aria-label="Fit chart to screen"
          >
            <Maximize2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          {placedCount > 0 ? (
            <button
              className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
              onClick={() => {
                haptic("tick");
                resetPositions();
              }}
              title="Reset layout"
              aria-label="Reset the cards you moved"
            >
              <RotateCcw className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
            </button>
          ) : null}
        </div>

        {cardDrag ? (
          <div
            data-testid="org-chart-top-zone"
            className={cn(
              "pointer-events-none absolute top-3 right-14 left-3 z-20 flex min-h-10 items-center justify-center gap-2 rounded-lg border-2 border-dashed px-2 py-1 text-center text-xs font-medium transition-colors",
              cardDrag.top ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background/80 text-muted-foreground",
            )}
          >
            <ArrowUpToLine className="size-4" aria-hidden="true" />
            Drop here: reports to nobody (top of the org)
          </div>
        ) : (
          <p className="pointer-events-none absolute bottom-2 left-3 z-10 max-w-xs rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground">
            Drag a card onto someone to make them its manager, or to empty space to move it. On touch, hold a card first.
          </p>
        )}

        {/* SVG layer for edges */}
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{
            width: "100%",
            height: "100%",
          }}
        >
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {edges.map(({ parent, child }) => {
              const from = positionOf(parent);
              const to = positionOf(child);
              const x1 = from.x + CARD_W / 2;
              const y1 = from.y + CARD_H;
              const x2 = to.x + CARD_W / 2;
              const y2 = to.y;
              const midY = (y1 + y2) / 2;

              return (
                <path
                  key={`${parent.id}-${child.id}`}
                  d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={1.5}
                  opacity={cardDrag?.id === child.id && (cardDrag.target || cardDrag.top) ? 0.25 : 1}
                />
              );
            })}
            {cardDrag?.target
              ? (() => {
                  const manager = allNodes.find((node) => node.id === cardDrag.target);
                  if (!manager) return null;
                  const from = positionOf(manager);
                  const x1 = from.x + CARD_W / 2;
                  const y1 = from.y + CARD_H;
                  const x2 = cardDrag.x + CARD_W / 2;
                  const y2 = cardDrag.y;
                  return (
                    <path
                      data-testid="org-chart-preview-edge"
                      d={`M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="var(--primary)"
                      strokeWidth={2}
                      strokeDasharray="6 4"
                    />
                  );
                })()
              : null}
          </g>
        </svg>

        {/* Card layer */}
        <div
          data-testid="org-chart-card-layer"
          className="absolute inset-0"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {allNodes.map((node) => {
            const agent = agentMap.get(node.id);
            const dotColor = statusDotColor[node.status] ?? defaultDotColor;
            const at = positionOf(node);
            const dragged = cardDrag?.id === node.id;
            const dropTarget = cardDrag?.target === node.id;
            const blockedTarget = cardDrag?.blocked === node.id;
            const targetName = cardDrag?.target ? agentMap.get(cardDrag.target)?.name : null;

            return (
              <Card
                key={node.id}
                data-org-card
                data-org-card-id={node.id}
                data-dragging={dragged ? "true" : undefined}
                data-drop-target={dropTarget ? "true" : undefined}
                className={cn(
                  "block absolute py-0 hover:shadow-md hover:border-foreground/20 transition-(--tp-box-shadow-border-color) duration-150 cursor-pointer select-none touch-none",
                  dragged && "z-30 cursor-grabbing shadow-lg ring-2 ring-primary",
                  dropTarget && "ring-2 ring-emerald-500 bg-emerald-500/10",
                  blockedTarget && "ring-2 ring-destructive",
                )}
                style={{
                  left: at.x,
                  top: at.y,
                  width: CARD_W,
                  minHeight: CARD_H,
                }}
                onPointerDown={(event) => handleCardPointerDown(event, node)}
                onPointerMove={handleCardPointerMove}
                onPointerUp={(event) => endCardPress(event, false)}
                onPointerCancel={(event) => endCardPress(event, true)}
                onContextMenu={(event) => event.preventDefault()}
                onClick={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
                onClickCapture={(e) => {
                  if (!suppressNextCardClick.current) return;
                  suppressNextCardClick.current = false;
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <div className="flex items-center px-4 py-3 gap-3">
                  {/* Agent icon + status dot */}
                  <div className="relative shrink-0">
                    <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                      <AgentAvatar agent={agent} size={16} className="h-4.5 w-4.5 text-foreground/70"/>
                    </div>
                    <span
                      className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card"
                      style={{ backgroundColor: dotColor }}
                    />
                  </div>
                  {/* Name + role + adapter type */}
                  <div className="flex flex-col items-start min-w-0 flex-1">
                    <span className="text-sm font-semibold text-foreground leading-tight">
                      {node.name}
                    </span>
                    <span className="text-(length:--text-micro) text-muted-foreground leading-tight mt-0.5">
                      {agent?.title && agent.title !== roleLabel(node.role) ? `${roleLabel(node.role)} · ${agent.title}` : roleLabel(node.role)}
                    </span>
                    {agent && (
                      <span className="text-(length:--text-nano) text-muted-foreground/60 font-mono leading-tight mt-1">
                        {getAdapterLabel(agent.adapterType)}
                      </span>
                    )}
                    {agent && agent.capabilities && (
                      <span className="text-(length:--text-nano) text-muted-foreground/80 leading-tight mt-1 line-clamp-2">
                        {agent.capabilities}
                      </span>
                    )}
                  </div>
                </div>
                {dragged && (targetName || cardDrag?.top) ? (
                  <span className="absolute -top-3 left-3 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground shadow-sm">
                    {targetName ? `Reports to ${targetName}` : "Top of the org"}
                  </span>
                ) : null}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
