// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiConnectionField } from "./AiConnectionField";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  list: vi.fn(),
  setDefault: vi.fn(),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));

const credentialStep = vi.hoisted(() => vi.fn());
vi.mock("./AiConnectionCredentialStep", () => ({
  AiConnectionCredentialStep: (props: {
    agentIds: string[];
    allAgents: boolean;
    onComplete: (result: { connectionId: string; grantId: string; method: "api_key" }) => void;
  }) => {
    credentialStep(props);
    return (
      <button type="button" onClick={() => props.onComplete({ connectionId: "conn-new", grantId: "grant-new", method: "api_key" })}>
        Finish connecting
      </button>
    );
  },
}));

let root: Root;
let host: HTMLDivElement;

function buttonByText(text: string) {
  return [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
}

async function click(text: string) {
  const button = buttonByText(text);
  if (!button) throw new Error(`No button "${text}"`);
  await act(async () => button.click());
}

async function mount(onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AiConnectionField
          companyId="company-1"
          agentId="agent-1"
          agentName="Ada"
          adapterType="claude_local"
          value={{ provider: "anthropic", method: "subscription", mode: "responsible_user" }}
          onChange={onChange}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(buttonByText("Connect another account")).toBeTruthy());
  return onChange;
}

describe("AiConnectionField: connecting another account", () => {
  beforeEach(() => {
    api.list.mockResolvedValue({
      currentUserId: "user-1",
      connections: [
        {
          id: "conn-old",
          grantId: "grant-old",
          companyId: "company-1",
          provider: "anthropic",
          method: "subscription",
          name: "Old subscription",
          ownership: "personal",
          ownerUserId: "user-1",
          ownerName: "You",
          isDefault: true,
          status: "expired",
        },
      ],
    });
    api.setDefault.mockResolvedValue({});
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.resetAllMocks();
  });

  it("makes the account connected here the default, set up for every agent, so the agent uses it", async () => {
    const onChange = await mount();
    await click("Connect another account");
    expect(credentialStep).toHaveBeenLastCalledWith(expect.objectContaining({ agentIds: [], allAgents: true }));

    await click("Finish connecting");
    await vi.waitFor(() => expect(api.setDefault).toHaveBeenCalledWith("company-1", "grant-new"));
    expect(onChange).toHaveBeenCalledWith({ provider: "anthropic", method: "api_key", mode: "responsible_user" });
    expect(document.body.querySelector("[data-testid=ai-connection-default-failed]")).toBeNull();
  });

  it("says when the account could not become the default, and Make it my default retries", async () => {
    api.setDefault.mockRejectedValueOnce(new Error("Could not reach the server"));
    await mount();
    await click("Connect another account");
    await click("Finish connecting");

    await vi.waitFor(() =>
      expect(document.body.querySelector("[data-testid=ai-connection-default-failed]")?.textContent).toContain("Could not reach the server"),
    );
    await click("Make it my default");
    await vi.waitFor(() => expect(document.body.querySelector("[data-testid=ai-connection-default-failed]")).toBeNull());
    expect(api.setDefault).toHaveBeenCalledTimes(2);
    expect(api.setDefault).toHaveBeenLastCalledWith("company-1", "grant-new");
  });
});
