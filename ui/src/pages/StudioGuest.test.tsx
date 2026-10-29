// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AUTOMA_CREDIT } from "@paperclipai/shared";
import { StudioGuest } from "./StudioGuest";

vi.mock("../api/studio", () => ({ studioGuestApi: {}, studioSocketUrl: () => "ws://studio.test" }));
vi.mock("../hooks/useStudioSocket", () => ({ useStudioSocket: () => ({ status: "open", send: () => undefined }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StudioGuest", () => {
  it("wraps the footer credit between its parts on a phone, never inside one", async () => {
    window.localStorage.removeItem("automa.studio.guest");
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<StudioGuest />));
      const footer = container.querySelector('[data-testid="studio-guest-credit"]')!;
      expect(footer.textContent).toBe(`Automa App Studio · ${AUTOMA_CREDIT}`);
      const credit = AUTOMA_CREDIT.split(" · ").map((part, index, parts) => (index < parts.length - 1 ? `${part} ·` : part));
      expect([...footer.querySelectorAll(".whitespace-nowrap")].map((part) => part.textContent)).toEqual(["Automa App Studio ·", ...credit]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
