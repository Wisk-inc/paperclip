// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTOMA_COMPANY, AUTOMA_CREDIT, AUTOMA_MAKER } from "@paperclipai/shared";
import { UI_STRINGS } from "@paperclipai/shared/ui-strings.generated";
import { loadBuiltinTranslations } from "@/i18n/builtin-translations";
import { FSI, LiveTranslator, PDI } from "@/i18n/live-translator";
import { buildUiStringIndex } from "@/i18n/ui-string-index";
import { AutomaCredit } from "./AutomaCredit";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let translator: LiveTranslator | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  translator?.stop();
  translator = null;
  act(() => root.unmount());
  container.remove();
});

/** The credit line on screen, in a language, as the board shows it (its built-in translations). */
async function creditIn(language: "es" | "ar" | "ja") {
  await act(async () => root.render(<AutomaCredit />));
  const translations = await loadBuiltinTranslations(language);
  translator = new LiveTranslator({
    root: container,
    index: buildUiStringIndex(UI_STRINGS),
    lookup: (source) => translations[source],
    isolate: language === "ar",
  });
  translator.start();
  return container.textContent;
}

describe("AutomaCredit", () => {
  it("reads as the credit line and can wrap only between its parts", () => {
    const html = renderToStaticMarkup(<AutomaCredit />);
    expect(html.replace(/<!-- -->/g, "")).toBe(
      '<span class="whitespace-nowrap"><span>By Nathan Lyttle</span> ·</span> <span class="whitespace-nowrap">Corx Labs ·</span> <span class="whitespace-nowrap">Made in Jamaica 🇯🇲</span>',
    );
    expect(html.replace(/<[^>]+>/g, "")).toBe(AUTOMA_CREDIT);
  });

  it("is shown in the person's language, the names and the flag as they are", async () => {
    expect(await creditIn("es")).toBe("Por Nathan Lyttle · Corx Labs · Hecho en Jamaica 🇯🇲");
  });

  it("keeps the names in their own direction in a right-to-left language", async () => {
    expect(await creditIn("ar")).toBe(`بواسطة ${FSI}${AUTOMA_MAKER}${PDI} · ${AUTOMA_COMPANY} · صُنع في جامايكا ${FSI}🇯🇲${PDI}`);
  });

  it("puts the English back when the board goes back to English", async () => {
    expect(await creditIn("ja")).not.toBe(AUTOMA_CREDIT);
    translator!.stop();
    translator = null;
    expect(container.textContent).toBe(AUTOMA_CREDIT);
  });
});
