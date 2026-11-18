// @vitest-environment jsdom

// A language switch must reach the pages already open. Words are translated
// where they stand, but a date or number is written when its component renders,
// so before the board's root listened for the change, switching to Spanish left
// "Nov 17" on the open page until a reload. This drives the real <App> route
// table with a page that writes a date, and switches the format locale the way
// the language provider does.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setFormatLocale } from "./i18n/format-locale";
import { App } from "./App";

const streamlinedUiState = vi.hoisted(() => ({ enabled: true, loaded: true }));
const page = vi.hoisted(() => ({
  mounts: 0,
  written: new Date(Date.UTC(2026, 10, 17, 14, 6)),
  options: { month: "short", day: "numeric", timeZone: "UTC" } as Intl.DateTimeFormatOptions,
}));

vi.mock("./hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => streamlinedUiState,
}));

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts,
// pulled into <App>'s import graph through @codesandbox/sandpack-react (see
// App.activity-routing.test.tsx): a benign rule takes its place.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __automaFormatLocalePatched?: boolean;
  };
  if (!sheetProto.__automaFormatLocalePatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".automa-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__automaFormatLocalePatched = true;
  }
});

// The page only: the real Layout renders the whole signed-in shell.
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

vi.mock("./components/Layout.production", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

// A page that writes a date the way the board's pages do: formatted when it
// renders, with no subscription of its own. It counts its mounts, so the test
// can tell a redraw from a remount (which would lose what someone is typing).
vi.mock("./pages/audit/CompanyActivity", async () => {
  const { useState } = await import("react");
  const { formatLocale } = await import("./i18n/format-locale");
  return {
    CompanyActivity: () => {
      useState(() => {
        page.mounts += 1;
        return null;
      });
      return <p>{`Written ${new Intl.DateTimeFormat(formatLocale(), page.options).format(page.written)}`}</p>;
    },
  };
});

const COMPANY = { id: "company-1", name: "Automa", issuePrefix: "PAP", status: "active" };
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [COMPANY],
    selectedCompanyId: COMPANY.id,
    selectedCompany: COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const written = (locale: string) => `Written ${new Intl.DateTimeFormat(locale, page.options).format(page.written)}`;

describe("a language switch and the pages already open", () => {
  afterEach(() => {
    setFormatLocale(null);
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("writes the dates on the open page in the new language, without remounting it", async () => {
    setFormatLocale("en-US");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <MemoryRouter initialEntries={["/PAP/activity"]}>
          <App />
        </MemoryRouter>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain(written("en-US")));
    const mounts = page.mounts;

    // What the language provider does when the person picks Spanish in Mexico.
    flushSync(() => setFormatLocale("es-MX"));

    await vi.waitFor(() => expect(container.textContent).toContain(written("es-MX")));
    expect(container.textContent).not.toContain(written("en-US"));
    expect(page.mounts).toBe(mounts);
    flushSync(() => root.unmount());
  });
});
