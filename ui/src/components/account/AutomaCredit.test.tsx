// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AUTOMA_CREDIT } from "@paperclipai/shared";
import { AutomaCredit } from "./AutomaCredit";

describe("AutomaCredit", () => {
  it("reads as the credit line and can wrap only between its parts", () => {
    const html = renderToStaticMarkup(<AutomaCredit />);
    expect(html).toBe(
      '<span class="whitespace-nowrap">By Nathan Lyttle ·</span> <span class="whitespace-nowrap">Corx Labs ·</span> <span class="whitespace-nowrap">Made in Jamaica 🇯🇲</span>',
    );
    expect(html.replace(/<[^>]+>/g, "")).toBe(AUTOMA_CREDIT);
  });
});
