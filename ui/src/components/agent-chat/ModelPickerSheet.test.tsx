// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { onlineManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { byRecency, freeHealthNote, modelVersion, ModelPickerSheet } from "./ModelPickerSheet";

const mockAgentsApi = vi.hoisted(() => ({ adapterModels: vi.fn(), update: vi.fn() }));
const mockAiConnectionsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockFreeModelsApi = vi.hoisted(() => ({ usage: vi.fn(), resetUsage: vi.fn(), health: vi.fn(), queStats: vi.fn(), moanStatus: vi.fn() }));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: mockAiConnectionsApi }));
vi.mock("@/api/free-models", () => ({ freeModelsApi: mockFreeModelsApi }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }), useOptionalToastActions: () => ({ pushToast: mockPushToast }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE_MODELS = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
];
const OPENROUTER_MODELS = [
  { id: "openrouter/deepseek/deepseek-r1", label: "DeepSeek: R1" },
  { id: "openrouter/deepseek/deepseek-v4.1-flash", label: "DeepSeek: DeepSeek V4.1 Flash" },
  { id: "openrouter/meta-llama/llama-4-maverick", label: "Meta: Llama 4 Maverick" },
  { id: "openrouter/anthropic/claude-sonnet-5", label: "Anthropic: Claude Sonnet 5" },
];

const FREE_MODELS = [
  { id: "deepseek/deepseek-v4.1-flash:free", label: "DeepSeek V4.1 Flash" },
  { id: "@cf/bytedance/stable-diffusion-xl-lightning", label: "SDXL Lightning (fast) · image" },
];
const USAGE = { since: null, replies: 3, images: 1, inputTokens: 1200, outputTokens: 800, equivalentUsd: 0.0031 };

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Nova",
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-4-5-20250929" },
    runtimeConfig: {},
    ...overrides,
  } as Agent;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(ui: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  });
  return {
    rerender: (next: React.ReactNode) => act(async () => root!.render(<QueryClientProvider client={client}>{next}</QueryClientProvider>)),
  };
}

/** The picker fed from the agent list in the cache, the way the chat page feeds it. */
function CachedAgentPicker({ reload }: { reload: () => Promise<Agent[]> }) {
  const agents = useQuery({ queryKey: queryKeys.agents.list("company-1"), queryFn: reload, staleTime: Infinity });
  return agents.data?.[0] ? <ModelPickerSheet agent={agents.data[0]} open onOpenChange={() => {}} /> : null;
}

function cachedClient(seed: Agent) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.agents.list("company-1"), [seed]);
  return client;
}

async function settle(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function row(id: string) {
  return document.querySelector<HTMLButtonElement>(`[data-slot="model-row"][data-model-id="${id}"]`);
}

beforeEach(() => {
  mockAgentsApi.adapterModels.mockImplementation((_company: string, type: string, options?: { provider?: string }) =>
    Promise.resolve(type === "opencode_local" && options?.provider === "openrouter" ? OPENROUTER_MODELS : type === "free_models" ? FREE_MODELS : CLAUDE_MODELS));
  mockAgentsApi.update.mockResolvedValue({});
  mockFreeModelsApi.usage.mockResolvedValue(USAGE);
  mockFreeModelsApi.health.mockResolvedValue({});
  mockFreeModelsApi.queStats.mockResolvedValue({ maxInFlight: 10, inFlight: 0, waiting: 0, started: 0, peakInFlight: 0, cachedAnswers: 3, cacheHits: 0, conversations: 0 });
  mockFreeModelsApi.resetUsage.mockResolvedValue({ ...USAGE, since: "2026-10-26T00:00:00.000Z", replies: 0, images: 0, inputTokens: 0, outputTokens: 0, equivalentUsd: 0 });
  mockAiConnectionsApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("model ordering", () => {
  it("reads the main version, ignoring dates and parameter sizes", () => {
    expect(modelVersion("DeepSeek V4.1 Flash")).toBe(4.1);
    expect(modelVersion("R1 0528")).toBe(1);
    expect(modelVersion("R1 Distill Llama 70B")).toBe(1);
    expect(modelVersion("Qwen3.8 Max")).toBe(3.8);
  });

  it("puts the newest model first and variants after their base model", () => {
    const names = [
      { id: "a", name: "R1" },
      { id: "b:batch", name: "DeepSeek V4.1 Flash (batch)" },
      { id: "c", name: "DeepSeek V3.2" },
      { id: "d", name: "DeepSeek V4.1 Flash" },
    ].sort(byRecency).map((entry) => entry.name);
    expect(names).toEqual(["DeepSeek V4.1 Flash", "DeepSeek V3.2", "R1", "DeepSeek V4.1 Flash (batch)"]);
  });
});

describe("ModelPickerSheet", () => {
  it("opens already searching for the model named in /model", async () => {
    await render(<ModelPickerSheet agent={agent()} open initialQuery="llama" onOpenChange={() => {}} />);
    await settle(() => expect(row("openrouter/meta-llama/llama-4-maverick")).not.toBeNull());
    const search = document.querySelector('input[aria-label="Search models"]') as HTMLInputElement;
    expect(search.value).toBe("llama");
    expect(row("claude-opus-4-8")).toBeNull();
  });

  it("lists the agent's runtime models and every OpenRouter model with clean names", async () => {
    await render(<ModelPickerSheet agent={agent()} open onOpenChange={() => {}} />);
    await settle(() => expect(row("openrouter/deepseek/deepseek-v4.1-flash")).not.toBeNull());
    expect(row("claude-opus-4-8")?.textContent).toContain("Claude Opus 4.8");
    expect(row("openrouter/deepseek/deepseek-v4.1-flash")?.textContent).toContain("DeepSeek V4.1 Flash");
    expect(row("openrouter/meta-llama/llama-4-maverick")?.textContent).toContain("Llama 4 Maverick");
    const groups = [...document.querySelectorAll("[data-provider-group]")].map((node) => node.getAttribute("data-provider-group"));
    expect(groups).toEqual(["anthropic", "deepseek", "meta"]);
    expect(row("claude-sonnet-4-5-20250929")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the newest Claude and GPT models first, only when the catalog has them", async () => {
    mockAgentsApi.adapterModels.mockImplementation((_company: string, type: string, options?: { provider?: string }) =>
      Promise.resolve(type === "opencode_local" && options?.provider === "openrouter"
        ? [
            ...OPENROUTER_MODELS,
            { id: "openrouter/anthropic/claude-opus-5.5", label: "Anthropic: Claude Opus 5.5" },
            { id: "openrouter/openai/gpt-6.1-sol", label: "OpenAI: GPT-6.1 Sol" },
          ]
        : CLAUDE_MODELS));
    await render(<ModelPickerSheet agent={agent()} open onOpenChange={() => {}} />);
    await settle(() => expect(document.querySelector('[data-testid="newest-models"]')).not.toBeNull());
    const newest = document.querySelector('[data-testid="newest-models"]')!;
    expect(newest.textContent).toContain("Claude Opus 5.5");
    expect(newest.textContent).toContain("GPT-6.1 Sol");
    // Listed in the catalog only, never invented: Fable 5.1 is not in this catalog.
    expect(newest.textContent).not.toContain("Fable");
  });

  it("switches the model within the agent's own runtime", async () => {
    const onOpenChange = vi.fn();
    await render(<ModelPickerSheet agent={agent()} open onOpenChange={onOpenChange} />);
    await settle(() => expect(row("claude-opus-4-8")).not.toBeNull());
    await act(async () => row("claude-opus-4-8")!.click());
    await settle(() => expect(mockAgentsApi.update).toHaveBeenCalled());
    expect(mockAgentsApi.update).toHaveBeenCalledWith("agent-1", { adapterConfig: { model: "claude-opus-4-8" } }, "company-1");
    await settle(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Nova now uses Claude Opus 4.8" }));
  });

  it("asks for an OpenRouter key before switching to DeepSeek without one", async () => {
    await render(<ModelPickerSheet agent={agent()} open onOpenChange={() => {}} />);
    await settle(() => expect(row("openrouter/deepseek/deepseek-r1")).not.toBeNull());
    await act(async () => row("openrouter/deepseek/deepseek-r1")!.click());
    expect(mockAgentsApi.update).not.toHaveBeenCalled();
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Add your OpenRouter key first",
      action: { label: "Add key", href: "/company/settings/api-keys?add=openrouter" },
    }));
  });

  it("moves the agent onto OpenCode with the person's OpenRouter key for any catalog model", async () => {
    mockAiConnectionsApi.list.mockResolvedValue({
      currentUserId: "user-1",
      connections: [{ id: "c1", grantId: "g1", companyId: "company-1", provider: "openrouter", method: "api_key", name: "Mine", ownership: "personal", isDefault: true, status: "connected" }],
    });
    await render(<ModelPickerSheet agent={agent({ runtimeConfig: { heartbeat: { enabled: true } } as Agent["runtimeConfig"] })} open onOpenChange={() => {}} />);
    await settle(() => expect(document.querySelector('[data-byok-provider="openrouter"]')?.textContent).toContain("Connected"));
    await act(async () => row("openrouter/deepseek/deepseek-v4.1-flash")!.click());
    await settle(() => expect(mockAgentsApi.update).toHaveBeenCalled());
    expect(mockAgentsApi.update).toHaveBeenCalledWith("agent-1", {
      adapterType: "opencode_local",
      adapterConfig: { model: "openrouter/deepseek/deepseek-v4.1-flash" },
      runtimeConfig: {
        heartbeat: { enabled: true },
        aiConnection: { provider: "openrouter", method: "api_key", mode: "responsible_user" },
      },
    }, "company-1");
  });

  it("tags free models, shows what they would have cost, and moves the agent onto them without a key", async () => {
    await render(<ModelPickerSheet agent={agent({ runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } } })} open onOpenChange={() => {}} />);
    await settle(() => expect(document.querySelector('[data-testid="free-usage"]')).not.toBeNull());
    const free = document.querySelector('[data-testid="free-models"]')!;
    expect(free.querySelectorAll('[data-slot="free-tag"]')).toHaveLength(2);
    expect(free.textContent).not.toMatch(/puter/i);
    await settle(() => expect(document.querySelector('[data-testid="que-engine"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="que-engine"]')?.textContent).toContain("Que engine");
    expect(document.querySelector('[data-testid="que-engine"]')?.textContent).toContain("ready · up to 10 answers at once");
    expect(document.querySelector('[data-testid="que-engine"]')?.textContent).toContain("3 cached");
    expect(document.querySelector('[data-testid="free-usage"]')?.textContent).toContain("2,000 tokens · 1 image · $0.00 charged");
    expect(document.querySelector('[data-testid="free-usage"]')?.textContent).toContain("Would have cost $0.0031 at paid prices");
    await act(async () => free.querySelector<HTMLButtonElement>('[data-model-id="deepseek/deepseek-v4.1-flash:free"]')!.click());
    await settle(() => expect(mockAgentsApi.update).toHaveBeenCalled());
    expect(mockAgentsApi.update).toHaveBeenCalledWith("agent-1", {
      adapterType: "free_models",
      adapterConfig: { model: "deepseek/deepseek-v4.1-flash:free" },
      runtimeConfig: {},
    }, "company-1");
  });

  it("shows tool toggles and an image bond for an agent on a free chat model", async () => {
    await render(<ModelPickerSheet agent={agent({ adapterType: "free_models", adapterConfig: { model: "deepseek/deepseek-v4.1-flash:free", freeWeb: false } })} open onOpenChange={() => {}} />);
    await settle(() => expect(document.querySelector('[data-testid="free-tools"]')).not.toBeNull());
    const panel = document.querySelector('[data-testid="free-tools"]')!;
    const web = panel.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Web search & reading"]')!;
    expect(web.getAttribute("aria-checked")).toBe("false");
    await act(async () => web.click());
    await settle(() => expect(mockAgentsApi.update).toHaveBeenCalledWith("agent-1", { adapterConfig: { freeWeb: true } }, "company-1"));
    const bond = [...panel.querySelectorAll("button")].find((b) => /SDXL Lightning/.test(b.textContent ?? ""))!;
    await act(async () => bond.click());
    expect(mockAgentsApi.update).toHaveBeenCalledWith("agent-1", { adapterConfig: { imageModel: "@cf/bytedance/stable-diffusion-xl-lightning" } }, "company-1");
  });

  it("hides the tool panel for an agent not on a free model", async () => {
    await render(<ModelPickerSheet agent={agent()} open onOpenChange={() => {}} />);
    await settle(() => expect(document.querySelector('[data-testid="free-models"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="free-tools"]')).toBeNull();
  });

  it("filters to free models and resets free usage", async () => {
    await render(<ModelPickerSheet agent={agent({ adapterType: "free_models", adapterConfig: { model: "deepseek/deepseek-v4.1-flash:free" } })} open onOpenChange={() => {}} />);
    await settle(() => expect(document.querySelector('[data-testid="free-usage"]')).not.toBeNull());
    const chip = [...document.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Free"))!;
    await act(async () => chip.click());
    expect(document.querySelector('[aria-label="Models with your OpenRouter key"]')).toBeNull();
    expect(row("deepseek/deepseek-v4.1-flash:free")?.getAttribute("aria-pressed")).toBe("true");
    const reset = [...document.querySelectorAll("button")].find((button) => button.textContent === "Reset")!;
    await act(async () => reset.click());
    await settle(() => expect(document.querySelector('[data-testid="free-usage"]')?.textContent).toMatch(/^0 tokens · \$0\.00 charged/));
    expect(document.querySelector('[data-testid="free-usage"]')?.textContent).toContain("Would have cost $0.00 at paid prices");
    expect(mockFreeModelsApi.resetUsage).toHaveBeenCalledWith("company-1");
  });
});

describe("free model health notes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down to the reset and drops a hold whose time has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
    const checkedAt = "2026-10-28T11:00:00.000Z";
    expect(freeHealthNote({ state: "daily_limit", until: "2026-10-28T13:40:00.000Z", checkedAt })).toBe("Daily free limit reached · back in 1 h 40 min");
    expect(freeHealthNote({ state: "daily_limit", until: "2026-10-28T12:04:30.000Z", checkedAt })).toBe("Daily free limit reached · back in 5 min");
    expect(freeHealthNote({ state: "daily_limit", until: null, checkedAt })).toBe("Daily free limit reached · back later today");
    expect(freeHealthNote({ state: "daily_limit", until: "2026-10-28T11:58:00.000Z", checkedAt })).toBeNull();
    expect(freeHealthNote({ state: "withdrawn", until: "2026-10-28T11:59:00.000Z", checkedAt })).toBeNull();
    expect(freeHealthNote({ state: "withdrawn", until: "2026-10-28T12:03:00.000Z", checkedAt })).toBe("Offline at its provider · checked again with each message");
  });
});

describe("ModelPickerSheet switching", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it("sends the switch worked out on the tap when it had to wait for a connection", async () => {
    const reload = vi.fn(() => Promise.resolve([agent()]));
    await render(<CachedAgentPicker reload={reload} />, cachedClient(agent()));
    await settle(() => expect(row("deepseek/deepseek-v4.1-flash:free")).not.toBeNull());
    onlineManager.setOnline(false);
    await act(async () => row("deepseek/deepseek-v4.1-flash:free")!.click());
    // The tap shows at once: the sheet already treats the agent as a free one.
    await settle(() => expect(document.querySelector('[data-testid="free-tools"]')).not.toBeNull());
    expect(mockAgentsApi.update).not.toHaveBeenCalled();
    await act(async () => onlineManager.setOnline(true));
    await settle(() => expect(mockAgentsApi.update).toHaveBeenCalled());
    expect(mockAgentsApi.update).toHaveBeenCalledWith("agent-1", {
      adapterType: "free_models",
      adapterConfig: { model: "deepseek/deepseek-v4.1-flash:free" },
      runtimeConfig: {},
    }, "company-1");
  });

  it("puts the old model back when a switch fails, even if the agent can't be reloaded", async () => {
    mockAgentsApi.update.mockRejectedValue(new Error("Automa's server is restarting"));
    const reload = vi.fn(() => Promise.reject(new Error("Automa's server is restarting")));
    const client = cachedClient(agent());
    await render(<CachedAgentPicker reload={reload} />, client);
    await settle(() => expect(row("deepseek/deepseek-v4.1-flash:free")).not.toBeNull());
    await act(async () => row("deepseek/deepseek-v4.1-flash:free")!.click());
    await settle(() => expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn’t switch the model" })));
    await settle(() => expect(reload).toHaveBeenCalled());
    await settle(() => expect(client.getQueryState(queryKeys.agents.list("company-1"))?.fetchStatus).toBe("idle"));
    const [cached] = client.getQueryData<Agent[]>(queryKeys.agents.list("company-1"))!;
    expect(cached!.adapterType).toBe("claude_local");
    expect(cached!.adapterConfig.model).toBe("claude-sonnet-4-5-20250929");
    expect(row("claude-sonnet-4-5-20250929")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("turns a tool back when the change fails, even if the agent can't be reloaded", async () => {
    mockAgentsApi.update.mockRejectedValue(new Error("Automa's server is restarting"));
    const freeAgent = agent({ adapterType: "free_models", adapterConfig: { model: "deepseek/deepseek-v4.1-flash:free" } });
    const reload = vi.fn(() => Promise.reject(new Error("Automa's server is restarting")));
    const client = cachedClient(freeAgent);
    await render(<CachedAgentPicker reload={reload} />, client);
    await settle(() => expect(document.querySelector('[data-testid="free-tools"]')).not.toBeNull());
    const files = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Files & commands"]')!;
    expect(files().getAttribute("aria-checked")).toBe("true");
    await act(async () => files().click());
    await settle(() => expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn’t change the setting" })));
    await settle(() => expect(reload).toHaveBeenCalled());
    await settle(() => expect(client.getQueryState(queryKeys.agents.list("company-1"))?.fetchStatus).toBe("idle"));
    expect(files().getAttribute("aria-checked")).toBe("true");
  });

  it("opens on every maker even when the Free chip was left on, so /model finds what it named", async () => {
    const view = await render(<ModelPickerSheet agent={agent()} open onOpenChange={() => {}} />);
    await settle(() => expect(row("openrouter/meta-llama/llama-4-maverick")).not.toBeNull());
    const freeChip = [...document.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Free"))!;
    await act(async () => freeChip.click());
    expect(row("openrouter/meta-llama/llama-4-maverick")).toBeNull();
    await view.rerender(<ModelPickerSheet agent={agent()} open={false} onOpenChange={() => {}} />);
    await view.rerender(<ModelPickerSheet agent={agent()} open initialQuery="llama" onOpenChange={() => {}} />);
    await settle(() => expect(row("openrouter/meta-llama/llama-4-maverick")).not.toBeNull());
  });

  it("says nothing matched when a search under the Free chip finds no free model", async () => {
    await render(<ModelPickerSheet agent={agent()} open initialQuery="zzz" onOpenChange={() => {}} />);
    await settle(() => expect(document.body.textContent).toContain("No models match “zzz”."));
    const freeChip = [...document.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Free"))!;
    await act(async () => freeChip.click());
    expect(document.body.textContent).toContain("No models match “zzz”.");
  });
});

describe("ModelPickerSheet on a phone server older than the app", () => {
  it("leaves out the free usage, Que and Moan cards instead of showing a missing route, and stops asking", async () => {
    const missing = () => Promise.reject(new ApiError("API route not found", 404, { error: "API route not found" }));
    mockFreeModelsApi.usage.mockImplementation(missing);
    mockFreeModelsApi.queStats.mockImplementation(missing);
    mockFreeModelsApi.moanStatus.mockImplementation(missing);
    mockFreeModelsApi.health.mockImplementation(missing);
    // The app's own retry rules, not the test default of none.
    const client = new QueryClient();
    const moan = agent({ adapterType: "free_models", adapterConfig: { model: "moan/moan-1:free" } });
    await render(<ModelPickerSheet agent={moan} open onOpenChange={() => {}} />, client);
    await settle(() => expect(document.querySelector('[data-testid="free-models"]')).not.toBeNull());
    for (const key of [queryKeys.freeModels.usage("company-1"), queryKeys.freeModels.que("company-1"), queryKeys.freeModels.moan(), queryKeys.freeModels.health()]) {
      await settle(() => expect(client.getQueryState(key)?.status).toBe("error"));
    }
    expect(document.body.textContent).not.toContain("API route not found");
    expect(document.querySelector('[data-testid="free-usage"]')).toBeNull();
    expect(document.querySelector('[data-testid="que-engine"]')).toBeNull();
    expect(document.querySelector('[data-testid="moan-knowledge"]')).toBeNull();
    expect(mockFreeModelsApi.queStats).toHaveBeenCalledTimes(1);
    const que = client.getQueryCache().find({ queryKey: queryKeys.freeModels.que("company-1") })!;
    const interval = que.observers[0]!.options.refetchInterval;
    expect(typeof interval === "function" ? interval(que) : interval).toBe(false);
    client.clear();
  });

  it("still retries and shows a Que engine error that is not a missing route", async () => {
    mockFreeModelsApi.queStats.mockRejectedValue(new ApiError("The Que engine is not answering", 503, { error: "The Que engine is not answering" }));
    await render(<ModelPickerSheet agent={agent()} open onOpenChange={() => {}} />, new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } }));
    await settle(() => expect(document.body.textContent).toContain("The Que engine is not answering"));
    expect(mockFreeModelsApi.queStats).toHaveBeenCalledTimes(4);
  });
});
