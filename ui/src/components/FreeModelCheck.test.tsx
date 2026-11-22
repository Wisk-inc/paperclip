// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOAN_MODEL_ID, resolveFreeModel } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { checkRemainder, FreeModelCheck, freeModelHealthOf, offlineCount } from "./FreeModelCheck";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ health: vi.fn(), checkHealth: vi.fn() }));
const toasts = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("@/api/free-models", () => ({ freeModelsApi: api }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: toasts.push }) }));

const A = "nvidia/nemotron-3-ultra-550b-a55b:free";
const B = "deepseek/deepseek-v4.1-flash:free";
const C = "recursive/flint-v1.0:free";
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

async function render(models: readonly string[] = [A, B, C]) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FreeModelCheck models={models} />
      </QueryClientProvider>,
    ),
  );
}
const row = () => host.querySelector("[data-testid=free-model-check]");
const button = () => host.querySelector<HTMLButtonElement>("[data-testid=free-model-check-start]")!;

beforeEach(() => {
  api.health.mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
});

describe("FreeModelCheck", () => {
  it("asks every free model on request, says how many answer and fills the record the lists read", async () => {
    await render();
    await vi.waitFor(() => expect(row()?.textContent).toContain("Free models come and go at their providers."));
    expect(button().textContent).toContain("Check");

    let finish!: (value: unknown) => void;
    api.checkHealth.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await act(async () => button().click());
    expect(row()?.textContent).toContain("Asking each free model for one word.");
    expect(button().disabled).toBe(true);

    const found = {
      checkedAt: iso(0),
      total: 3,
      answering: 2,
      health: {
        [A]: { state: "ok", until: null, checkedAt: iso(0), last: "ok" },
        [B]: { state: "withdrawn", until: iso(-300_000), checkedAt: iso(0), last: "withdrawn" },
      },
    };
    await act(async () => finish(found));
    await vi.waitFor(() => expect(row()?.textContent).toContain("2 of 3 free models answer right now. The others are marked in the lists."));
    expect(button().textContent).toContain("Check again");
    expect(button().disabled).toBe(false);
    expect(client.getQueryData(queryKeys.freeModels.health())).toEqual(found.health);
    expect(toasts.push).not.toHaveBeenCalled();
  });

  it("tells a model that was only busy from one the lists mark, and says nothing more when all answer", async () => {
    const check = async (found: unknown) => {
      api.checkHealth.mockResolvedValue(found);
      await act(async () => button().click());
    };
    await render();
    await vi.waitFor(() => expect(row()).not.toBeNull());

    // Five asked, two answer: one is closed at its provider (the lists mark it), two were busy or at their limit.
    await check({
      checkedAt: iso(0),
      total: 5,
      answering: 2,
      health: {
        [A]: { state: "ok", until: null, checkedAt: iso(0), last: "ok" },
        [B]: { state: "withdrawn", until: iso(-300_000), checkedAt: iso(0), last: "withdrawn" },
        [C]: { state: "busy", until: iso(-60_000), checkedAt: iso(0), last: "busy" },
        "some/limited:free": { state: "daily_limit", until: iso(-3600_000), checkedAt: iso(0), last: "daily_limit" },
      },
    });
    await vi.waitFor(() =>
      expect(row()?.textContent).toContain("2 of 5 free models answer right now. Marked in the lists: 1. Only busy or at a limit, may answer later: 2."),
    );
    expect(row()?.textContent).not.toContain("The others are marked");

    // None closed: nothing is marked, so nothing is said to be.
    await check({ checkedAt: iso(0), total: 3, answering: 2, health: { [C]: { state: "busy", until: iso(-60_000), checkedAt: iso(0), last: "busy" } } });
    await vi.waitFor(() => expect(row()?.textContent).toContain("2 of 3 free models answer right now. The others were busy or at a limit and may answer later."));

    // All answer.
    await check({ checkedAt: iso(0), total: 3, answering: 3, health: { [A]: { state: "ok", until: null, checkedAt: iso(0), last: "ok" } } });
    await vi.waitFor(() => expect(row()?.textContent).toContain("3 of 3 free models answer right now."));
    expect(row()?.textContent).not.toContain("others");
    expect(row()?.textContent).not.toContain("Marked in the lists");
  });

  it("counts as marked only what the lists mark", () => {
    const entry = (state: string, last = state) => ({ state, until: state === "ok" ? null : iso(-300_000), checkedAt: iso(0), last });
    const result = (answering: number, total: number, health: Record<string, unknown>) => ({ checkedAt: iso(0), total, answering, health }) as never;
    expect(checkRemainder(result(2, 5, { a: entry("ok"), b: entry("withdrawn"), c: entry("restricted"), d: entry("busy") }))).toEqual({ marked: 2, unmarked: 1 });
    expect(checkRemainder(result(3, 3, { a: entry("ok") }))).toEqual({ marked: 0, unmarked: 0 });
    // A model with no record at all (it never answered in any way) is not marked either.
    expect(checkRemainder(result(1, 4, { a: entry("ok"), b: entry("charged") }))).toEqual({ marked: 1, unmarked: 2 });
    // Never more marked than did not answer, whatever the record holds.
    expect(checkRemainder(result(2, 3, { b: entry("withdrawn"), c: entry("withdrawn") }))).toEqual({ marked: 1, unmarked: 0 });
  });

  it("says how many of the listed models did not answer when one was found offline earlier", async () => {
    api.health.mockResolvedValue({
      [B]: { state: "ok", until: null, checkedAt: iso(2 * 3600_000), last: "withdrawn" },
      [C]: { state: "ok", until: null, checkedAt: iso(30 * 3600_000), last: "withdrawn" },
      "some/other:free": { state: "withdrawn", until: iso(-60_000), checkedAt: iso(0), last: "withdrawn" },
    });
    await render();
    await vi.waitFor(() => expect(row()?.textContent).toContain("1 of these free models did not answer when last asked."));
  });

  it("keeps what is known and says why when the check fails", async () => {
    api.health.mockResolvedValue({ [B]: { state: "ok", until: null, checkedAt: iso(60_000), last: "withdrawn" } });
    api.checkHealth.mockRejectedValue(new ApiError("Can't reach the free models right now. Check the connection and try again.", 502, { error: "x" }));
    await render();
    await vi.waitFor(() => expect(row()?.textContent).toContain("1 of these"));
    await act(async () => button().click());
    await vi.waitFor(() => expect(toasts.push).toHaveBeenCalledTimes(1));
    expect(toasts.push.mock.calls[0]![0]).toMatchObject({ title: "Couldn't check the free models", tone: "error" });
    expect(toasts.push.mock.calls[0]![0].body).toContain("Can't reach the free models right now");
    expect(row()?.textContent).toContain("1 of these");
    expect(button().disabled).toBe(false);
  });

  it("says to update when the server on the device has no check yet, and hides on one with no record at all", async () => {
    api.checkHealth.mockRejectedValue(new ApiError("API route not found", 404, { error: "API route not found" }));
    await render();
    await vi.waitFor(() => expect(row()).not.toBeNull());
    await act(async () => button().click());
    await vi.waitFor(() => expect(toasts.push).toHaveBeenCalledTimes(1));
    expect(toasts.push.mock.calls[0]![0].body).toContain("older than the app");

    act(() => root.unmount());
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.health.mockRejectedValue(new ApiError("API route not found", 404, { error: "API route not found" }));
    await render();
    await vi.waitFor(() => expect(api.health).toHaveBeenCalled());
    await vi.waitFor(() => expect(row()).toBeNull());
  });
});

describe("reading the record for a listed model", () => {
  it("looks Moan up under the model it runs on, and counts only models known to be offline", () => {
    const moanRunsOn = resolveFreeModel(MOAN_MODEL_ID).puterModel;
    const health = {
      [moanRunsOn]: { state: "withdrawn" as const, until: iso(-60_000), checkedAt: iso(0) },
      [B]: { state: "busy" as const, until: iso(-60_000), checkedAt: iso(0) },
    };
    expect(freeModelHealthOf(health, MOAN_MODEL_ID)).toBe(health[moanRunsOn]);
    expect(freeModelHealthOf(undefined, A)).toBeUndefined();
    expect(offlineCount(health, [MOAN_MODEL_ID, B, C])).toBe(1);
    expect(offlineCount(undefined, [A, B])).toBe(0);
  });
});
