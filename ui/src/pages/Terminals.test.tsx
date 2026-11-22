// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TERMINAL_TOOLS } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_STRINGS } from "@paperclipai/shared/ui-strings.generated";
import { defaultLanguageLabel, defaultModelLabel, launchModel, modelOptionLabel, offeredLanguage, offeredModel, Terminals, terminalSizeGuess } from "./Terminals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const company = vi.hoisted(() => ({ id: null as string | null }));
const search = vi.hoisted(() => ({ value: new URLSearchParams() }));
const api = vi.hoisted(() => ({
  status: vi.fn(),
  sessions: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("@/api/terminals", () => ({ terminalsApi: api }));
// Which free models answer; empty unless a test fills it.
const freeApi = vi.hoisted(() => ({ health: vi.fn(), checkHealth: vi.fn() }));
vi.mock("@/api/free-models", () => ({ freeModelsApi: freeApi }));
// The model catalog the server keeps; empty unless a test fills it.
const catalogApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/modelCatalog", () => ({ modelCatalogApi: catalogApi }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: company.id }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/lib/router", () => ({ useSearchParams: () => [search.value, vi.fn()] }));
vi.mock("@/components/terminals/TerminalView", () => ({ TerminalView: () => <div data-testid="terminal-view" /> }));
vi.mock("@/components/mascot/Mascot", () => ({ Mascot: () => null }));

const freechat = TERMINAL_TOOLS.find((tool) => tool.id === "freechat")!;
const claude = TERMINAL_TOOLS.find((tool) => tool.id === "claude")!;
const imy = TERMINAL_TOOLS.find((tool) => tool.id === "imy")!;

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

function tools(installed: Record<string, boolean> = {}) {
  return TERMINAL_TOOLS.map((tool) => ({ id: tool.id, installed: installed[tool.id] ?? false }));
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Terminals />
      </QueryClientProvider>,
    ),
  );
}

function tile(id: string) {
  return host.querySelector<HTMLButtonElement>(`[data-testid=terminal-tool][data-tool=${id}]`)!;
}

beforeEach(() => {
  company.id = "company-1";
  search.value = new URLSearchParams();
  window.localStorage.clear();
  api.status.mockResolvedValue({ kind: "phone", linuxReady: true, relayReady: true, tools: tools({ claude: true }) });
  api.sessions.mockResolvedValue({ sessions: [] });
  catalogApi.get.mockResolvedValue({ source: "built-in", fetchedAt: null, models: [] });
  freeApi.health.mockResolvedValue({});
  api.start.mockResolvedValue({
    session: { id: "s1", companyId: "company-1", toolId: "claude", title: "Claude Code", cwd: "/", status: "running", exitCode: null, createdAt: "2026-11-02T00:00:00.000Z", agentId: null },
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
});

describe("Terminals page", () => {
  it("offers models released after this Automa in Gemini CLI's list, from the catalog the server keeps", async () => {
    const created = Math.floor(Date.now() / 1000) - 5 * 86_400;
    catalogApi.get.mockResolvedValue({
      source: "live",
      fetchedAt: new Date().toISOString(),
      models: [{ id: "google/gemini-5-pro", name: "Google: Gemini 5 Pro", created, context: 1_000_000, tools: true, input: ["text"], output: ["text"], price: null }],
    });
    await render();
    await vi.waitFor(() => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Model for Gemini CLI"]');
      expect([...(select?.options ?? [])].map((option) => option.value).slice(0, 2)).toEqual(["", "gemini-5-pro"]);
    });
  });

  it("survives a cold load that renders before an organization is chosen", async () => {
    company.id = null;
    await render();
    company.id = "company-1";
    await render();
    await vi.waitFor(() => expect(host.querySelector("[data-testid=terminals-page]")).not.toBeNull());
  });

  it("looks again at what is installed when you come back from a terminal", async () => {
    await render();
    await vi.waitFor(() => expect(tile("claude")).toBeTruthy());
    expect(api.status).toHaveBeenCalledTimes(1);

    await act(async () => tile("claude").click());
    await vi.waitFor(() => expect(host.querySelector("[data-testid=terminal-view]")).not.toBeNull());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to terminals"]')!.click());

    await vi.waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
  });

  it("says Python is missing and keeps the tools from failing one by one", async () => {
    api.status.mockResolvedValue({ kind: "phone", linuxReady: true, relayReady: false, tools: tools({ claude: true }) });
    await render();

    await vi.waitFor(() => expect(host.querySelector("[data-testid=terminals-relay-missing]")?.textContent).toContain("pkg install python"));
    expect(tile("claude").disabled).toBe(true);
    expect(tile("shell").disabled).toBe(true);
  });

  it("opens an agent's tool with the agent's model from its link", async () => {
    search.value = new URLSearchParams({ tool: "claude", agent: "6f1c2c0e-7d55-4a60-9a8f-3f2f8b2d4c11", model: "claude-sonnet-4-6" });
    await render();

    await vi.waitFor(() => expect(api.start).toHaveBeenCalled());
    expect(api.start).toHaveBeenCalledWith("company-1", expect.objectContaining({
      toolId: "claude",
      mode: "run",
      agentId: "6f1c2c0e-7d55-4a60-9a8f-3f2f8b2d4c11",
      model: "claude-sonnet-4-6",
    }));
  });

  it("lists IMY with its free models, and opens it with the exact model picked", async () => {
    api.status.mockResolvedValue({ kind: "phone", linuxReady: true, relayReady: true, tools: tools({ imy: true }) });
    await render();
    await vi.waitFor(() => expect(tile("imy")).toBeTruthy());
    expect(tile("imy").textContent).toContain("Invent your own syntax");
    expect(tile("imy").textContent).toContain("Ready");

    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Model for IMY"]')!;
    expect(select.options[0]!.textContent).toBe("IMY's own setting (free models at first)");
    expect([...select.options].slice(1).map((option) => option.value)).toEqual(imy.models);
    expect(imy.models!.some((id) => id.startsWith("moan/"))).toBe(false);

    // Nothing picked: IMY starts with its own setting, so no model is sent.
    await act(async () => tile("imy").click());
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]![1]).toMatchObject({ toolId: "imy", mode: "run" });
    expect(api.start.mock.calls[0]![1]).not.toHaveProperty("model");
    expect(api.start.mock.calls[0]![1]).not.toHaveProperty("language");
  });

  it("lets IMY be opened in a programming language, remembers the choice, and never translates a language's name", async () => {
    api.status.mockResolvedValue({ kind: "phone", linuxReady: true, relayReady: true, tools: tools({ imy: true }) });
    await render();
    await vi.waitFor(() => expect(tile("imy")).toBeTruthy());

    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Language for IMY"]')!;
    expect(select).not.toBeNull();
    expect(select.options[0]!.textContent).toBe("IMY's own language (Python at first)");
    expect(select.value).toBe("");
    const offered = [...select.options].slice(1);
    expect(offered.map((option) => option.value)).toEqual(imy.languages!.map((language) => language.id));
    expect(offered.map((option) => option.textContent)).toEqual(imy.languages!.map((language) => language.name));
    for (const wanted of ["Python", "JavaScript", "Ruby", "Rust", "C", "C++", "Go", "Zig", "Assembly"]) {
      expect(offered.map((option) => option.textContent)).toContain(wanted);
    }
    // "Go", "Swift" and "Rust" are names, not words: the board's translator must pass them over.
    for (const option of offered) expect(option.getAttribute("translate")).toBe("no");
    expect(select.options[0]!.hasAttribute("translate")).toBe(false);
    // Only IMY takes a language.
    expect(host.querySelectorAll("select[data-testid=terminal-language]")).toHaveLength(1);

    // Picking a language does not open the terminal; the tile does, in that language.
    await act(async () => {
      select.value = "rust";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(api.start).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("automa.terminals.languages")!)).toEqual({ imy: "rust" });
    expect(select.value).toBe("rust");

    await act(async () => tile("imy").click());
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]![1]).toMatchObject({ toolId: "imy", mode: "run", language: "rust" });
    expect(api.start.mock.calls[0]![1]).not.toHaveProperty("model");
  });

  it("opens IMY in the language saved on this device, with the model picked, and ignores a language it no longer lists", async () => {
    window.localStorage.setItem("automa.terminals.models", JSON.stringify({ imy: imy.models![1] }));
    window.localStorage.setItem("automa.terminals.languages", JSON.stringify({ imy: "javascript", claude: "rust" }));
    api.status.mockResolvedValue({ kind: "phone", linuxReady: true, relayReady: true, tools: tools({ imy: true, claude: true }) });
    await render();
    await vi.waitFor(() => expect(tile("imy")).toBeTruthy());
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Language for IMY"]')!.value).toBe("javascript");
    await act(async () => tile("imy").click());
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]![1]).toMatchObject({ toolId: "imy", mode: "run", model: imy.models![1], language: "javascript" });
  });

  it("never sends a language to a tool that takes none, or one the menu does not list", async () => {
    window.localStorage.setItem("automa.terminals.languages", JSON.stringify({ imy: "klingon", claude: "rust" }));
    api.status.mockResolvedValue({ kind: "phone", linuxReady: true, relayReady: true, tools: tools({ imy: true, claude: true }) });
    await render();
    await vi.waitFor(() => expect(tile("imy")).toBeTruthy());
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Language for IMY"]')!.value).toBe("");
    await act(async () => tile("imy").click());
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]![1]).not.toHaveProperty("language");
    await vi.waitFor(() => expect(host.querySelector("[data-testid=terminal-view]")).not.toBeNull());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to terminals"]')!.click());
    await vi.waitFor(() => expect(tile("claude")).toBeTruthy());
    await act(async () => tile("claude").click());
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.start.mock.calls[1]![1]).toMatchObject({ toolId: "claude", mode: "run" });
    expect(api.start.mock.calls[1]![1]).not.toHaveProperty("language");
  });

  it("opens IMY with the model picked in its menu, and installs it first when it is missing", async () => {
    window.localStorage.setItem("automa.terminals.models", JSON.stringify({ imy: imy.models![1] }));
    api.status.mockResolvedValue({ kind: "phone", linuxReady: true, relayReady: true, tools: tools({ imy: true }) });
    await render();
    await vi.waitFor(() => expect(tile("imy")).toBeTruthy());
    await act(async () => tile("imy").click());
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]![1]).toMatchObject({ toolId: "imy", mode: "run", model: imy.models![1] });
  });

  it("updates IMY once when this Automa ships a newer one, then opens what is installed", async () => {
    api.status.mockResolvedValue({
      kind: "phone",
      linuxReady: true,
      relayReady: true,
      tools: TERMINAL_TOOLS.map((tool) => (tool.id === "imy" ? { id: tool.id, installed: true, update: true } : { id: tool.id, installed: false })),
    });
    await render();
    await vi.waitFor(() => expect(tile("imy")).toBeTruthy());
    expect(tile("imy").textContent).toContain("Tap to update");
    expect(tile("claude").textContent).toContain("Tap to install");

    await act(async () => tile("imy").click());
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]![1]).toMatchObject({ toolId: "imy", mode: "install" });

    // Back on the page with the update not gone through (no connection): IMY opens as it is.
    await vi.waitFor(() => expect(host.querySelector("[data-testid=terminal-view]")).not.toBeNull());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to terminals"]')!.click());
    await vi.waitFor(() => expect(tile("imy")).toBeTruthy());
    expect(tile("imy").textContent).toContain("Ready");
    await act(async () => tile("imy").click());
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.start.mock.calls[1]![1]).toMatchObject({ toolId: "imy", mode: "run" });
  });

  it("installs IMY on the first tap when it is not on the device yet", async () => {
    await render();
    await vi.waitFor(() => expect(tile("imy")).toBeTruthy());
    expect(tile("imy").textContent).toContain("Tap to install");
    await act(async () => tile("imy").click());
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]![1]).toMatchObject({ toolId: "imy", mode: "install" });
    expect(api.start.mock.calls[0]![1]).not.toHaveProperty("model");
    expect(api.start.mock.calls[0]![1]).not.toHaveProperty("language");
  });

  it("marks free models that did not answer in the IMY and Free models menus, and checks them all on request", async () => {
    const gone = imy.models![1]!;
    const checkedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    freeApi.health.mockResolvedValue({ [gone]: { state: "ok", until: null, checkedAt, last: "withdrawn" } });
    await render();
    const menu = (label: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="Model for ${label}"]`)!;
    await vi.waitFor(() => expect([...menu("IMY").options].find((option) => option.value === gone)?.textContent).toContain("· not answering now"));
    expect([...menu("Free models").options].find((option) => option.value === gone)?.textContent).toContain("· not answering now");
    expect([...menu("IMY").options].filter((option) => option.textContent?.includes("not answering now"))).toHaveLength(1);
    // A tool with its own account is never marked from the free models' record.
    expect([...menu("Claude Code").options].some((option) => option.textContent?.includes("not answering now"))).toBe(false);

    const row = host.querySelector("[data-testid=free-model-check]")!;
    expect(row.textContent).toContain("1 of these free models did not answer when last asked.");

    const other = imy.models![2]!;
    const now = new Date().toISOString();
    freeApi.checkHealth.mockResolvedValue({
      checkedAt: now,
      total: 23,
      answering: 12,
      health: {
        [gone]: { state: "ok", until: null, checkedAt: now, last: "ok" },
        [other]: { state: "withdrawn", until: new Date(Date.now() + 300_000).toISOString(), checkedAt: now, last: "withdrawn" },
      },
    });
    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid=free-model-check-start]")!.click());
    await vi.waitFor(() => expect(row.textContent).toContain("12 of 23 free models answer right now."));
    expect(freeApi.checkHealth).toHaveBeenCalledTimes(1);
    // The menus follow the fresh answer: the one that is back loses its mark, the one now offline gets it.
    await vi.waitFor(() => expect([...menu("IMY").options].find((option) => option.value === other)?.textContent).toContain("· not answering now"));
    expect([...menu("IMY").options].find((option) => option.value === gone)?.textContent).not.toContain("not answering now");
    expect(row.querySelector("button")!.textContent).toContain("Check again");
    // Checking never opens a terminal.
    expect(api.start).not.toHaveBeenCalled();
  });

  it("drops a model from the link that the server would refuse", async () => {
    search.value = new URLSearchParams({ tool: "claude", model: "bad model; rm -rf /" });
    await render();

    await vi.waitFor(() => expect(api.start).toHaveBeenCalled());
    expect(api.start.mock.calls[0]![1]).not.toHaveProperty("model");
  });
});

describe("terminal model choice", () => {
  it("ignores a saved model the tool no longer offers", () => {
    expect(offeredModel(claude, "a-model-from-an-old-release")).toBeUndefined();
    expect(offeredModel(claude, claude.models![0])).toBe(claude.models![0]);
  });

  it("opens the free models with the model the picker calls Default", () => {
    expect(launchModel(freechat, undefined)).toBe(freechat.models![0]);
    expect(launchModel(freechat, "gone-model")).toBe(freechat.models![0]);
    // Other tools keep their own default.
    expect(launchModel(claude, undefined)).toBeUndefined();
  });

  it("says what opens when no model is picked", () => {
    expect(defaultModelLabel(freechat)).toMatch(/^Default \(.+\)$/);
    expect(defaultModelLabel(imy)).toBe("IMY's own setting (free models at first)");
    expect(defaultModelLabel(claude)).toBe("The tool's own default model");
    expect(launchModel(imy, undefined)).toBeUndefined();
    expect(launchModel(imy, imy.models![0])).toBe(imy.models![0]);
  });

  it("says in a menu when a free model did not answer, for the tools that run on free models only", () => {
    const model = imy.models![0]!;
    const plain = modelOptionLabel("imy", model, {});
    expect(plain).toContain(model);
    expect(plain).not.toContain("not answering");
    const offline = { [model]: { state: "withdrawn" as const, until: new Date(Date.now() + 60_000).toISOString(), checkedAt: new Date().toISOString() } };
    expect(modelOptionLabel("imy", model, offline)).toBe(`${plain} · not answering now`);
    expect(modelOptionLabel("freechat", model, offline)).toBe(`${plain} · not answering now`);
    expect(modelOptionLabel("claude", model, offline)).toBe(plain);
    // Busy or at its daily limit is not offline: it answers again by itself.
    const busy = { [model]: { state: "busy" as const, until: new Date(Date.now() + 60_000).toISOString(), checkedAt: new Date().toISOString() } };
    expect(modelOptionLabel("imy", model, busy)).toBe(plain);
  });

  it("keeps every tool's name, description and default-model line in the text the board may translate", () => {
    const board = new Set<string>(UI_STRINGS);
    const missing = TERMINAL_TOOLS.flatMap((tool) => [tool.label, tool.blurb]).filter((text) => !board.has(text));
    expect(missing).toEqual([]);
    expect(board.has(defaultModelLabel(imy))).toBe(true);
    expect(board.has(defaultModelLabel(claude))).toBe(true);
    expect(board.has("Default ({0})")).toBe(true);
    expect(board.has(defaultLanguageLabel(imy))).toBe(true);
    expect(board.has(defaultLanguageLabel(claude))).toBe(true);
    expect(board.has("Language for {0}")).toBe(true);
  });

  it("starts a terminal at the width the screen will really show", () => {
    // A phone: about 55 columns, not the 80 a tool would otherwise lay its first lines out for.
    expect(terminalSizeGuess(412, 915)).toEqual({ cols: 55, rows: 49 });
    expect(terminalSizeGuess(360, 640)).toEqual({ cols: 48, rows: 32 });
    // A computer's window.
    expect(terminalSizeGuess(1280, 800)).toEqual({ cols: 176, rows: 42 });
    // Never smaller or larger than a terminal can sensibly be, and never not a number.
    expect(terminalSizeGuess(100, 100)).toEqual({ cols: 40, rows: 12 });
    expect(terminalSizeGuess(5000, 5000)).toEqual({ cols: 200, rows: 100 });
    expect(terminalSizeGuess(Number.NaN, Number.NaN)).toEqual({ cols: 80, rows: 24 });
  });

  it("keeps a saved language only while the tool lists it", () => {
    expect(offeredLanguage(imy, "rust")).toBe("rust");
    expect(offeredLanguage(imy, "asm")).toBe("asm");
    expect(offeredLanguage(imy, "klingon")).toBeUndefined();
    expect(offeredLanguage(imy, undefined)).toBeUndefined();
    expect(offeredLanguage(imy, "")).toBeUndefined();
    expect(offeredLanguage(claude, "rust")).toBeUndefined();
    expect(defaultLanguageLabel(imy)).toBe("IMY's own language (Python at first)");
    expect(defaultLanguageLabel(claude)).toBe("The tool's own language");
  });
});
