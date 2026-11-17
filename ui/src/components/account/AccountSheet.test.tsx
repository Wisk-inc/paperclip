// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";

const reloadApp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reload-app", () => ({ reloadApp }));
vi.mock("@/api/auth", () => ({
  authApi: { getSession: async () => ({ user: { id: "local-board", name: "Board", email: null }, session: { id: "s", userId: "local-board" } }) },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ companies: [], selectedCompany: null, selectedCompanyId: null, setSelectedCompanyId: vi.fn() }),
}));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openOnboarding: vi.fn() }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/hooks/useSignOut", () => ({ useSignOut: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
  useLocation: () => ({ pathname: "/YAA/dashboard" }),
  useNavigate: () => vi.fn(),
}));
// Parts of the sheet this test is not about.
vi.mock("./AccountBalanceCard", () => ({ AccountBalanceCard: () => null }));
vi.mock("./AutomaCredit", () => ({ AutomaCredit: () => null }));
vi.mock("./AboutAutomaSheet", () => ({ AboutAutomaSheet: () => null }));
vi.mock("../AppearancePicker", () => ({ AppearancePicker: () => null }));
vi.mock("../DiscordSupportLink", () => ({ DiscordSupportLink: () => null }));
import { AccountSheet } from "./AccountSheet";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Resolve = (callId: string, payload: string) => void;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

/** The Automa app's bridge; `canTroubleshoot`: Automa runs on this phone. */
function inTheApp(canTroubleshoot: boolean) {
  const runTroubleshooter = vi.fn((_key: string, callId: string) => {
    setTimeout(() => (window as unknown as { __automaNative: { resolve: Resolve } }).__automaNative.resolve(
      callId,
      JSON.stringify({ ok: true, output: "Summary\nNo problems found.", problems: false }),
    ), 5);
  });
  Object.assign(window, {
    __automaKey: "page-key",
    AutomaNative: { getInfo: () => JSON.stringify({ appVersion: "1.9.12" }), canTroubleshoot: () => canTroubleshoot, runTroubleshooter },
  });
  return runTroubleshooter;
}

beforeEach(() => {
  reloadApp.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "local-board", name: "Board", email: null }, session: { id: "s", userId: "local-board" } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  client.clear();
  for (const key of ["AutomaNative", "__automaKey", "__automaNative"]) delete (window as unknown as Record<string, unknown>)[key];
});

async function show(onOpenChange = vi.fn(), open = true) {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <AccountSheet open={open} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  ));
  return onOpenChange;
}
const row = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('section[aria-label="Account"] button')).find((button) => button.textContent?.startsWith(label));

describe("AccountSheet's Troubleshoot and Reload app", () => {
  it("Reload app loads the whole board again", async () => {
    await show();
    expect(row("Reload app")).toBeTruthy();
    await act(async () => row("Reload app")!.click());
    expect(reloadApp).toHaveBeenCalledTimes(1);
  });

  it("offers Troubleshoot in the Automa app for Automa on this phone: the sheet closes and the report shows", async () => {
    const run = inTheApp(true);
    const onOpenChange = await show();
    expect(row("Troubleshoot")).toBeTruthy();
    await act(async () => row("Troubleshoot")!.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await show(onOpenChange, false);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="troubleshoot-dialog"]')?.textContent).toContain("No problems found");
  });

  it("does not offer Troubleshoot for a server elsewhere, nor outside the app", async () => {
    inTheApp(false);
    await show();
    expect(row("Troubleshoot")).toBeUndefined();
    await act(async () => root.unmount());
    root = createRoot(container);
    for (const key of ["AutomaNative", "__automaKey"]) delete (window as unknown as Record<string, unknown>)[key];
    await show();
    expect(row("Troubleshoot")).toBeUndefined();
    expect(row("Reload app")).toBeTruthy();
  });
});
