// @vitest-environment jsdom

// A tapped notification moves the open tab from one App Studio project to
// another without a reload (`automa:open-path` in ui/public/sw.js). The
// workspace page keeps the open file, the editor text and the AI turns in
// component state, so the second project must get its own instance: with the
// first one's state it shows the wrong file and saves it into the wrong
// project.

import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { StudioWorkspaceRoute } from "./StudioWorkspaceRoute";

// jsdom's CSS parser rejects a rule that a library in <App>'s import graph
// inserts; see App.cases-routing.test.tsx for the full story.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __studioRoutePatched?: boolean;
  };
  if (!sheetProto.__studioRoutePatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".studio-route-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__studioRoutePatched = true;
  }
});

const lifecycle = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }));

// Stands in for the real page: like it, it reads the id from the address and
// keeps what it opened with in state for as long as the instance lives.
vi.mock("./StudioWorkspace", async () => {
  const react = await import("react");
  const router = await import("react-router-dom");
  return {
    StudioWorkspace: () => {
      const { workspaceId = "" } = router.useParams();
      const [openedWith] = react.useState(workspaceId);
      react.useEffect(() => {
        lifecycle.mounts.push(workspaceId);
        return () => {
          lifecycle.unmounts.push(workspaceId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return (
        <div data-testid="workspace">
          address:{workspaceId} state:{openedWith}
        </div>
      );
    },
  };
});

vi.mock("../components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});
vi.mock("../components/OnboardingWizardVariant", () => ({ OnboardingWizardVariant: () => null }));
vi.mock("../components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

const COMPANY = { id: "company-1", name: "Automa", issuePrefix: "PAP", status: "active" };
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [COMPANY], selectedCompanyId: COMPANY.id, selectedCompany: COMPANY, loading: false }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Hands the test the router's navigate, which is what the notification handler calls. */
function Navigator({ onReady }: { onReady: (navigate: NavigateFunction) => void }) {
  const navigate = useNavigate();
  useEffect(() => {
    onReady(navigate);
  }, [navigate, onReady]);
  return null;
}

describe("the App Studio workspace route", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    lifecycle.mounts.length = 0;
    lifecycle.unmounts.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  async function openThenMove(tree: ReactNode, from: string, to: string) {
    let navigate: NavigateFunction | null = null;
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[from]}>
          <Navigator onReady={(ready) => (navigate = ready)} />
          {tree}
        </MemoryRouter>,
      ),
    );
    await vi.waitFor(() => expect(container.querySelector('[data-testid="workspace"]')?.textContent).toBe("address:a state:a"));
    expect(lifecycle.mounts).toEqual(["a"]);

    await act(async () => {
      void navigate!(to);
    });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="workspace"]')?.textContent).toContain("address:b"));
    return root;
  }

  function expectFreshInstance() {
    // Nothing of project A is left: its instance went away and B started from nothing.
    expect(container.querySelector('[data-testid="workspace"]')?.textContent).toBe("address:b state:b");
    expect(lifecycle.unmounts).toEqual(["a"]);
    expect(lifecycle.mounts).toEqual(["a", "b"]);
  }

  it("starts a fresh workspace when the address moves from one project to another", async () => {
    const root = await openThenMove(
      <Routes>
        <Route path="studio/:workspaceId" element={<StudioWorkspaceRoute />} />
      </Routes>,
      "/studio/a",
      "/studio/b",
    );
    expectFreshInstance();
    await act(async () => root.unmount());
  });

  it("is what the board's own route table renders for a project", async () => {
    const root = await openThenMove(<App />, "/PAP/studio/a", "/PAP/studio/b");
    expectFreshInstance();
    await act(async () => root.unmount());
  });
});
