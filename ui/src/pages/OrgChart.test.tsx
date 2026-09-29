// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { OrgChart } from "./OrgChart";

const navigateMock = vi.fn();
const orgMock = vi.fn();
const listMock = vi.fn();
const updateMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigateMock,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    org: () => orgMock(),
    list: () => listMock(),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const orgTree = [
  {
    id: "agent-1",
    name: "CEO",
    role: "ceo",
    status: "active",
    reports: [
      {
        id: "agent-2",
        name: "Engineer",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ],
  },
];

const agents = [
  {
    id: "agent-1",
    companyId: "company-1",
    name: "CEO",
    role: "ceo",
    title: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "briefcase",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "ceo",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
  {
    id: "agent-2",
    companyId: "company-1",
    name: "Engineer",
    role: "engineer",
    title: null,
    status: "active",
    reportsTo: "agent-1",
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "code",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "engineer",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
];

function createTouchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: touches,
  });
  Object.defineProperty(event, "changedTouches", {
    value: touches,
  });
  return event;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("OrgChart mobile gestures", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let viewportWidth: number;
  let viewportHeight: number;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    viewportWidth = 360;
    viewportHeight = 520;
    orgMock.mockResolvedValue(orgTree);
    listMock.mockResolvedValue(agents);

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? viewportWidth : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? viewportHeight : 0;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect(this: HTMLElement) {
      if (this.getAttribute("data-testid") === "org-chart-viewport") {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: viewportWidth,
          bottom: viewportHeight,
          width: viewportWidth,
          height: viewportHeight,
          toJSON: () => ({}),
        };
      }
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      };
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function renderOrgChart() {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OrgChart />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return {
      viewport: container.querySelector('[data-testid="org-chart-viewport"]') as HTMLDivElement,
      layer: container.querySelector('[data-testid="org-chart-card-layer"]') as HTMLDivElement,
    };
  }

  it("pans the chart with one-finger touch drag", async () => {
    const { viewport, layer } = await renderOrgChart();

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
    });

    expect(layer.style.transform).toBe("translate(50px, 105px) scale(1)");
  });

  it("suppresses card navigation after a touch pan", async () => {
    const { viewport } = await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLDivElement;

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("allows card navigation after a touch tap without movement", async () => {
    const { viewport } = await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLDivElement;

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith("/agents/ceo");
  });
  it("pinch-zooms toward the touch center", async () => {
    const { viewport, layer } = await renderOrgChart();

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 100 },
      ]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [
        { clientX: 75, clientY: 100 },
        { clientX: 225, clientY: 100 },
      ]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
    });

    expect(layer.style.transform).toBe("translate(-45px, 40px) scale(1.5)");
  });

  it("does not produce a negative zoom while the viewport has no usable height", async () => {
    viewportHeight = 2;
    const { layer } = await renderOrgChart();

    expect(layer.style.transform).toBe("translate(0px, 0px) scale(1)");

    await act(async () => {
      (container.querySelector('[aria-label="Fit chart to screen"]') as HTMLButtonElement).click();
    });

    expect(layer.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("shows both portability buttons on self-hosted instances", async () => {
    await renderOrgChart();

    expect(container.textContent).toContain("Import organization");
    expect(container.textContent).toContain("Export organization");
  });

  it("hides the Import button but keeps Export on a Cloud-managed instance", async () => {
    queryClient.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: true } });
    await renderOrgChart();

    expect(container.textContent).not.toContain("Import organization");
    expect(container.textContent).toContain("Export organization");
  });

  function cardCenter(layer: HTMLDivElement, id: string) {
    const card = layer.querySelector(`[data-org-card-id="${id}"]`) as HTMLElement;
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(layer.style.transform);
    const [panX, panY, zoom] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 1];
    return {
      card,
      x: panX + (Number.parseFloat(card.style.left) + 100) * zoom,
      y: panY + (Number.parseFloat(card.style.top) + 50) * zoom,
    };
  }

  function pointer(target: Element, type: string, x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    target.dispatchEvent(event);
  }

  async function drag(from: { card: HTMLElement; x: number; y: number }, to: { x: number; y: number }) {
    await act(async () => {
      pointer(from.card, "pointerdown", from.x, from.y);
      pointer(from.card, "pointermove", from.x + 10, from.y + 10);
      pointer(from.card, "pointermove", to.x, to.y);
      pointer(from.card, "pointerup", to.x, to.y);
    });
    await flushReact();
  }

  it("connects an agent to a new manager when its card is dropped on theirs", async () => {
    const withDesigner = [...orgTree, { id: "agent-3", name: "Designer", role: "designer", status: "active", reports: [] }];
    orgMock.mockResolvedValue(withDesigner);
    listMock.mockResolvedValue([...agents, { ...agents[0], id: "agent-3", name: "Designer", role: "designer", reportsTo: null }]);
    updateMock.mockResolvedValue({});
    const { layer } = await renderOrgChart();

    await drag(cardCenter(layer, "agent-3"), cardCenter(layer, "agent-1"));

    expect(updateMock).toHaveBeenCalledWith("agent-3", { reportsTo: "agent-1" }, "company-1");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("refuses a reporting line that would loop", async () => {
    const { layer } = await renderOrgChart();

    await drag(cardCenter(layer, "agent-1"), cardCenter(layer, "agent-2"));

    expect(updateMock).not.toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "CEO can’t report to Engineer", tone: "warn" }));
  });

  it("moves an agent to the top of the org from the top strip", async () => {
    updateMock.mockResolvedValue({});
    const { layer } = await renderOrgChart();

    await drag(cardCenter(layer, "agent-2"), { x: 180, y: 20 });

    expect(updateMock).toHaveBeenCalledWith("agent-2", { reportsTo: null }, "company-1");
  });

  it("keeps a card where it is dropped on empty space", async () => {
    const { layer } = await renderOrgChart();
    const engineer = cardCenter(layer, "agent-2");
    const before = Number.parseFloat(engineer.card.style.left);

    await drag(engineer, { x: engineer.x + 60, y: engineer.y + 80 });

    expect(updateMock).not.toHaveBeenCalled();
    expect(Number.parseFloat((layer.querySelector('[data-org-card-id="agent-2"]') as HTMLElement).style.left)).toBeGreaterThan(before);
    expect(window.localStorage.getItem("automa.orgChartPositions:company-1")).toContain("agent-2");
  });
});
