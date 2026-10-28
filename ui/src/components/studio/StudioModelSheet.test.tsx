// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { StudioModelSheet } from "./StudioModelSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StudioModelSheet", () => {
  it("keeps the model name box for a custom provider after the first letter", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    // The sheet reads the OpenRouter catalog through a query, so it needs a client.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const draw = (model: string) =>
      act(async () => root.render(
        <QueryClientProvider client={client}>
          <StudioModelSheet provider="custom" model={model} keys={[]} onChange={onChange} />
        </QueryClientProvider>,
      ));
    try {
      await draw("");
      await act(async () => (container.querySelector('[data-testid="studio-model-button"]') as HTMLButtonElement).click());
      expect(document.body.querySelector('input[aria-label="Model name"]')).not.toBeNull();
      await draw("l");
      const input = document.body.querySelector('input[aria-label="Model name"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input!.value).toBe("l");
      expect(document.body.querySelector('[role="radiogroup"][aria-label="Model"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("never says the free models need a key, also before the key list arrives", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => root.render(
        <QueryClientProvider client={client}>
          <StudioModelSheet provider="free" model="nvidia/nemotron-3-ultra-550b-a55b:free" keys={[]} onChange={vi.fn()} team={[{ provider: "free", model: "nvidia/nemotron-3.5-lightning:free" }]} onTeamChange={vi.fn()} />
        </QueryClientProvider>,
      ));
      const button = container.querySelector('[data-testid="studio-model-button"]') as HTMLButtonElement;
      expect(button.textContent).toContain("No key needed");
      expect(button.textContent).not.toContain("Add a key");
      await act(async () => button.click());
      expect(document.body.querySelector('[data-provider="free"]')?.textContent).toContain("No key needed");
      expect(document.body.querySelector('[data-testid="studio-teammate"]')?.textContent).not.toContain("needs a key");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
