// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_STRINGS } from "@paperclipai/shared/ui-strings.generated";
import { ToastProvider } from "../context/ToastContext";
import { setFormatLocale } from "../i18n/format-locale";
import { FSI, LiveTranslator, PDI } from "../i18n/live-translator";
import { buildUiStringIndex } from "../i18n/ui-string-index";
import { FreeModelsSavingsCard } from "./FreeModelsSavingsCard";

const usage = vi.hoisted(() => vi.fn());
vi.mock("@/api/free-models", () => ({ freeModelsApi: { usage, resetUsage: vi.fn() } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SINCE = "2026-10-26T12:00:00.000Z";
const USAGE = { since: SINCE, replies: 3, images: 2, inputTokens: 5_000, outputTokens: 1_201, equivalentUsd: 0.0046 };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  setFormatLocale(null);
  vi.clearAllMocks();
});

async function draw(data: typeof USAGE): Promise<HTMLElement> {
  usage.mockResolvedValue(data);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ToastProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <FreeModelsSavingsCard companyId="company-1" />
        </QueryClientProvider>
      </ToastProvider>,
    );
  });
  await vi.waitFor(() => expect(container?.querySelector('[data-testid="free-models-usage"]')).not.toBeNull());
  return container!.querySelector<HTMLElement>('[data-testid="free-models-usage"]')!;
}

describe("FreeModelsSavingsCard", () => {
  it("says what free work was done, image or images, and since when", async () => {
    let line = await draw(USAGE);
    expect(line.textContent).toBe(`6,201 tokens · 2 images · $0.00 charged · since ${new Date(SINCE).toLocaleDateString("en-US")}`);
    await act(async () => root?.unmount());
    root = null;
    line = await draw({ ...USAGE, images: 1, since: null as unknown as string });
    expect(line.textContent).toBe("6,201 tokens · 1 image · $0.00 charged");
  });

  it("is written phrase by phrase, so the on-screen translator shows all of it in the person's language", async () => {
    setFormatLocale("es-MX");
    const line = await draw(USAGE);
    // The board's real list of its own words, and Spanish for these phrases.
    const spanish: Record<string, string> = {
      "{0} tokens": "{0} tokens",
      "{0} images": "{0} imágenes",
      "$0.00 charged": "$0.00 cobrados",
      "since {0}": "desde {0}",
    };
    const translator = new LiveTranslator({ root: line, index: buildUiStringIndex(UI_STRINGS), lookup: (source) => spanish[source] });
    translator.start();
    expect(line.textContent).toBe(`6,201 tokens · 2 imágenes · $0.00 cobrados · desde ${new Date(SINCE).toLocaleDateString("es-MX")}`);
    translator.stop();
  });

  it("keeps the date in its own order in a right-to-left language", async () => {
    setFormatLocale("ar-EG");
    const line = await draw(USAGE);
    const arabic: Record<string, string> = {
      "{0} tokens": "{0} توكنز",
      "{0} images": "{0} صور",
      "$0.00 charged": "تم خصم $0.00",
      "since {0}": "منذ {0}",
    };
    const translator = new LiveTranslator({ root: line, index: buildUiStringIndex(UI_STRINGS), lookup: (source) => arabic[source], isolate: true });
    translator.start();
    const date = new Date(SINCE).toLocaleDateString("ar-EG-u-nu-latn");
    const phrases = [...line.querySelectorAll("span")].map((span) => span.textContent);
    // Each value sits in an isolate, so the date's parts and the Latin digits keep their order.
    expect(phrases).toEqual([`${FSI}6,201${PDI} توكنز`, `${FSI}2${PDI} صور`, "تم خصم $0.00", `منذ ${FSI}${date}${PDI}`]);
    translator.stop();
  });
});
