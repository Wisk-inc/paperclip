// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "@/lib/router";
import { InboxBell } from "./InboxBell";

const state = vi.hoisted(() => ({ companyId: "org-a", keys: ["approval:1"] as string[] }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ keys: state.keys }) }));
vi.mock("../lib/haptics", () => ({ haptic: () => undefined }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("InboxBell", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = () => act(() => root.render(<MemoryRouter><InboxBell /></MemoryRouter>));
  const count = () => container.querySelector('[data-testid="inbox-bell-count"]')?.textContent ?? null;

  beforeEach(() => {
    localStorage.clear();
    Object.assign(state, { companyId: "org-a", keys: ["approval:1"] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("clears the count when tapped, and it stays cleared after switching organizations", () => {
    render();
    expect(count()).toBe("1");
    act(() => (container.querySelector('[data-slot="inbox-bell"]') as HTMLAnchorElement).click());
    expect(count()).toBeNull();

    // Another organization with its own new item, seen there too.
    state.companyId = "org-b";
    state.keys = ["issue:9"];
    render();
    expect(count()).toBe("1");
    act(() => (container.querySelector('[data-slot="inbox-bell"]') as HTMLAnchorElement).click());
    expect(count()).toBeNull();

    // Back in the first organization the count does not come back.
    state.companyId = "org-a";
    state.keys = ["approval:1"];
    render();
    expect(count()).toBeNull();

    // Something new arrives: the count shows again, just for it.
    state.keys = ["approval:1", "approval:2"];
    render();
    expect(count()).toBe("1");
  });
});
