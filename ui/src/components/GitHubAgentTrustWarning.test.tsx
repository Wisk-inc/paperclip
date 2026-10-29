// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubAgentTrustWarning } from "./GitHubAgentTrustWarning";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("GitHubAgentTrustWarning", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("says where to contain the agent, without sending people to the upstream project's docs", async () => {
    await act(async () => root.render(<GitHubAgentTrustWarning agent={{ name: "Ada", permissions: {} }} />));

    expect(container.textContent).toContain("Ada is not configured for low-trust review");
    expect(container.textContent).toContain("open the agent’s settings and set Trust preset to Low-trust review.");
    expect(container.querySelector("a")).toBeNull();
  });

  it("stays out of the way for an agent already set to low-trust review", async () => {
    await act(async () => root.render(
      <GitHubAgentTrustWarning agent={{ name: "Ada", permissions: { trustPreset: "low_trust_review" } }} />,
    ));

    expect(container.textContent).toBe("");
  });
});
