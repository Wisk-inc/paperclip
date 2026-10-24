// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBasicsDialog, type AgentBasics } from "./AgentBasicsDialog";

vi.mock("@/api/adapters", () => ({
  adaptersApi: {
    list: async () => [
      { type: "claude_local", loaded: true, disabled: false },
      { type: "codex_local", loaded: true, disabled: false },
    ],
  },
}));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({}) } }));
vi.mock("@/hooks/useCloudInstance", () => ({ useCloudInstance: () => null }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c1" }) }));
vi.mock("@/hooks/useAgentAppearanceDraft", () => ({ useAgentAppearanceDraft: () => ({ appearance: null }) }));
vi.mock("../AgentCharacter", () => ({ AgentCharacter: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentBasicsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers the Anthropic API first and makes it a Claude agent that uses the API", async () => {
    const onContinue = vi.fn<(basics: AgentBasics) => void>();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AgentBasicsDialog open onClose={() => undefined} onContinue={onContinue} />
        </QueryClientProvider>,
      );
    });
    const input = document.querySelector("input#" + CSS.escape(document.querySelector("label[for]")!.getAttribute("for")!)) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Ann");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (document.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(document.querySelectorAll('input[name="new-agent-adapter"]').length).toBe(3));
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="new-agent-adapter"]')];
    expect(radios.map((radio) => radio.value)).toEqual(["anthropic_api", "claude_local", "codex_local"]);
    expect(document.body.textContent).toContain("Anthropic API");
    await act(async () => radios[0]!.click());
    await act(async () => {
      (document.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });
    expect(onContinue).toHaveBeenCalledWith({ name: "Ann", adapterType: "claude_local", runnerProvider: "claude", engine: "api" });
  });
});
