// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { byRecency, modelVersion, ModelPickerSheet } from "./ModelPickerSheet";

const mockAgentsApi = vi.hoisted(() => ({ adapterModels: vi.fn(), update: vi.fn() }));
const mockAiConnectionsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockFreeModelsApi = vi.hoisted(() => ({ usage: vi.fn(), resetUsage: vi.fn() }));

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

async function render(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  });
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
