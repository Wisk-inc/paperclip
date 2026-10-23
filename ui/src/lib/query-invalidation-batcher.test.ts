import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import {
  createCoalescingQueryClient,
  createInvalidationBatcher,
  HEAVY_REFETCH_GAP_MS,
  liveRefetchGapMs,
  reconcileFilter,
} from "./query-invalidation-batcher";

function fakeClient() {
  const calls: unknown[] = [];
  const client = {
    invalidateQueries: vi.fn((filters?: unknown) => {
      calls.push(filters);
      return Promise.resolve();
    }),
  };
  return { client, calls };
}

describe("createInvalidationBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("marks queries stale without refetching when the tab hides before flush", async () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client);
    const pending = batcher.schedule({ queryKey: ["dashboard", "c1"] });
    vi.stubGlobal("document", { visibilityState: "hidden" });
    await batcher.flush();
    await pending;
    expect(client.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["dashboard", "c1"], refetchType: "none" });
  });

  it("coalesces repeated invalidations of the same key into one call per window", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    for (let i = 0; i < 20; i++) batcher.schedule({ queryKey: ["dashboard", "c1"] });
    expect(client.invalidateQueries).not.toHaveBeenCalled(); // nothing until flush

    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["dashboard", "c1"] });
  });

  it("keeps distinct keys and distinct refetchType variants separate", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    batcher.schedule({ queryKey: ["b"] });
    batcher.schedule({ queryKey: ["a"] }); // dup of first
    batcher.schedule({ queryKey: ["a"], refetchType: "inactive" }); // distinct variant

    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(3);
  });

  it("never coalesces predicate-based invalidations", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    // Two distinct predicate filters must both run — they can't be proven equal.
    batcher.schedule({ predicate: () => true });
    batcher.schedule({ predicate: () => false });

    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("schedule() resolves only after the flush has invalidated", async () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    let resolved = false;
    const p = batcher.schedule({ queryKey: ["a"] }).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false); // not yet — window still open
    expect(client.invalidateQueries).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await p;
    expect(resolved).toBe(true);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh window after flushing", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);

    batcher.schedule({ queryKey: ["a"] });
    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("dispose cancels a pending flush", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    batcher.dispose();
    vi.advanceTimersByTime(1000);
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  it("flush() invalidates immediately", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    batcher.flush();
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);
  });
});

describe("createCoalescingQueryClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("batches invalidateQueries but passes other methods straight through", () => {
    const setQueryData = vi.fn();
    const getQueryData = vi.fn(() => ({ some: "data" }));
    const realInvalidate = vi.fn(() => Promise.resolve());
    const real = { invalidateQueries: realInvalidate, setQueryData, getQueryData } as unknown as QueryClient;

    const batcher = createInvalidationBatcher(
      { invalidateQueries: realInvalidate } as unknown as QueryClient,
      300,
    );
    const proxied = createCoalescingQueryClient(real, batcher);

    // setQueryData / getQueryData pass through immediately.
    proxied.setQueryData(["k"], 1);
    expect(setQueryData).toHaveBeenCalledWith(["k"], 1);
    expect(proxied.getQueryData(["k"])).toEqual({ some: "data" });

    // invalidateQueries is deferred through the batcher.
    void proxied.invalidateQueries({ queryKey: ["k"] });
    void proxied.invalidateQueries({ queryKey: ["k"] });
    expect(realInvalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(realInvalidate).toHaveBeenCalledTimes(1);
  });
});

describe("createInvalidationBatcher minimum gap", () => {
  it("refetches a heavy key at most once per gap, and once more at the end", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const calls: string[] = [];
      const client = { invalidateQueries: vi.fn(async (filters: { queryKey?: readonly unknown[] }) => { calls.push(String(filters.queryKey?.[0])); }) };
      const batcher = createInvalidationBatcher(client as never, 300, {
        minIntervalMs: (filters) => (filters.queryKey?.[0] === "dashboard" ? 4000 : 0),
        now: () => clock,
      });
      for (let i = 0; i < 10; i += 1) {
        batcher.schedule({ queryKey: ["dashboard", "c1"] });
        batcher.schedule({ queryKey: ["issues", "c1", "detail"] });
        clock += 400;
        await vi.advanceTimersByTimeAsync(400);
      }
      clock += 5000;
      await vi.advanceTimersByTimeAsync(5000);
      const dashboards = calls.filter((key) => key === "dashboard").length;
      const issues = calls.filter((key) => key === "issues").length;
      expect(issues).toBe(10);
      expect(dashboards).toBeLessThanOrEqual(3);
      expect(dashboards).toBeGreaterThanOrEqual(2);
      batcher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reconcileFilter and liveRefetchGapMs", () => {
  it("skips only data that live events never change", () => {
    const filter = reconcileFilter();
    const query = (key: unknown[]) => ({ queryKey: key, state: { dataUpdatedAt: 0 } }) as never;
    expect(filter.type).toBe("active");
    expect(filter.predicate?.(query(["issues", "c1", "list"]))).toBe(true);
    expect(filter.predicate?.(query(["adapters"]))).toBe(false);
    expect(filter.predicate?.(query(["instance", "settings"]))).toBe(false);
    expect(filter.predicate?.(query(["companies"]))).toBe(true);
  });

  it("only spaces out the lists that are costly to build", () => {
    expect(liveRefetchGapMs({ queryKey: ["dashboard", "c1"] })).toBe(HEAVY_REFETCH_GAP_MS);
    expect(liveRefetchGapMs({ queryKey: ["agents", "c1"] })).toBe(HEAVY_REFETCH_GAP_MS);
    expect(liveRefetchGapMs({ queryKey: ["agents", "detail", "a1"] })).toBe(0);
    expect(liveRefetchGapMs({ queryKey: ["issues", "c1", "touched-by-me"] })).toBe(HEAVY_REFETCH_GAP_MS);
    expect(liveRefetchGapMs({ queryKey: ["issues", "c1", "detail"] })).toBe(0);
    expect(liveRefetchGapMs({})).toBe(0);
  });
});
