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

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: mockAiConnectionsApi }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }) }));
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
    Promise.resolve(type === "opencode_local" && options?.provider === "openrouter" ? OPENROUTER_MODELS : CLAUDE_MODELS));
  mockAgentsApi.update.mockResolvedValue({});
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
      action: { label: "Add key", href: "/apps/connect?source=openrouter" },
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
});
