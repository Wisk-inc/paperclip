// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { FeatureTour, TOUR_STOPS } from "./FeatureTour";
import { requestFeatureTour } from "@/lib/feature-tour";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/mascot/Mascot", () => ({ Mascot: () => null }));

describe("FeatureTour", () => {
  it("covers every part with how-to steps, starting with a welcome", () => {
    expect(TOUR_STOPS[0]!.title).toBe("Welcome to Automa");
    expect(TOUR_STOPS.at(-1)!.title).toBe("You're ready");
    for (const stop of TOUR_STOPS) expect(stop.steps.length).toBeGreaterThanOrEqual(3);
    const titles = TOUR_STOPS.map((stop) => stop.title);
    expect(titles).toEqual(expect.arrayContaining(["Chats", "Models and thinking", "App Studio", "API keys and spending"]));
  });

  it("opens on request, walks the steps, and can be skipped at any card", async () => {
    window.localStorage.clear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<FeatureTour />));
      expect(document.body.querySelector('[data-testid="feature-tour"]')).toBeNull();
      await act(async () => requestFeatureTour());
      expect(document.body.textContent).toContain("Welcome to Automa");
      expect(document.body.querySelectorAll('[data-testid="feature-tour-steps"] li')).toHaveLength(TOUR_STOPS[0]!.steps.length);
      await act(async () => (document.body.querySelector('[data-testid="feature-tour-next"]') as HTMLButtonElement).click());
      expect(document.body.textContent).toContain("Home");
      expect(document.body.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe(`2 of ${TOUR_STOPS.length}`);
      await act(async () => (document.body.querySelector('[data-testid="feature-tour-skip"]') as HTMLButtonElement).click());
      expect(document.body.querySelector('[data-testid="feature-tour"]')).toBeNull();
      expect(window.localStorage.getItem("automa.tour.seen")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
