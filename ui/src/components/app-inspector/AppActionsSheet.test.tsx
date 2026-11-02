// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppActionsSheet, type PickerApp } from "./AppActionsSheet";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const app: PickerApp = {
  package: "com.example.app",
  label: "Example",
  versionName: "1.0",
  sizeBytes: 1024,
  splitCount: 0,
  system: false,
  updatedAt: 0,
  iconUrl: null,
  sourceDir: null,
  apkUrl: null,
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

async function render(javaUnavailable: boolean, onDecompile = vi.fn()) {
  await act(async () =>
    root.render(
      <AppActionsSheet
        app={app}
        busy={false}
        phase={null}
        onDecompile={onDecompile}
        onExtract={null}
        onAsk={null}
        onOpenChange={vi.fn()}
        javaUnavailable={javaUnavailable}
      />,
    ),
  );
  return onDecompile;
}

const javaSwitch = () => document.body.querySelector<HTMLButtonElement>("[data-testid=inspector-option-java]")!;

describe("AppActionsSheet: Code as Java", () => {
  it("is on by default where jadx can run", async () => {
    await render(false);
    expect(javaSwitch().getAttribute("aria-checked")).toBe("true");
    expect(javaSwitch().disabled).toBe(false);
  });

  it("is off, can't be turned on and says why on a computer without jadx, so a decompile never fails on it", async () => {
    const onDecompile = await render(true);
    expect(javaSwitch().getAttribute("aria-checked")).toBe("false");
    expect(javaSwitch().disabled).toBe(true);
    expect(document.body.textContent).toContain("Needs jadx installed on this computer");

    await act(async () => document.body.querySelector<HTMLButtonElement>("[data-testid=inspector-open]")!.click());
    expect(onDecompile).toHaveBeenCalledWith(app, { resources: true, sources: true, java: false });
  });

  it("turns Java off when the status arrives after the sheet opened", async () => {
    await render(false);
    expect(javaSwitch().getAttribute("aria-checked")).toBe("true");
    await render(true);
    expect(javaSwitch().getAttribute("aria-checked")).toBe("false");
  });
});
