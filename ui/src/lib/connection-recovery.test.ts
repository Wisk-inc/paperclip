import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/api/client";
import {
  isReachabilityError,
  reconnectRetryDelay,
  RECONNECT_CHECK_DELAYS_MS,
  retryWhileUnreachable,
  SERVER_BACK_EVENT,
  startConnectionRecovery,
  type ConnectionRecoveryDeps,
} from "./connection-recovery";

const offline = () => new ApiError(NETWORK_ERROR_MESSAGE, 0, null);

/** A board query whose server is away until `serverUp` is set. */
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const state = { serverUp: false, fetches: 0 };
  const observer = new QueryObserver(queryClient, {
    queryKey: ["issues"],
    queryFn: async () => {
      state.fetches += 1;
      if (!state.serverUp) throw offline();
      return ["issue"];
    },
  });
  const unsubscribe = observer.subscribe(() => undefined);
  const target = new EventTarget();
  const checks = vi.fn(async () => state.serverUp);
  let visible = true;
  const deps: ConnectionRecoveryDeps = {
    checkServer: checks,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    target: target as unknown as ConnectionRecoveryDeps["target"],
    isVisible: () => visible,
  };
  return {
    queryClient,
    state,
    observer,
    target,
    checks,
    deps,
    setVisible: (value: boolean) => { visible = value; },
    cleanup: () => { unsubscribe(); queryClient.clear(); },
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("isReachabilityError", () => {
  it("counts a request that never reached the server, a raw fetch failure and a server error", () => {
    expect(isReachabilityError(offline())).toBe(true);
    expect(isReachabilityError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isReachabilityError(new ApiError("database_unreachable", 503, null))).toBe(true);
  });

  it("never counts a real answer", () => {
    expect(isReachabilityError(new ApiError("Not found", 404, null))).toBe(false);
    expect(isReachabilityError(new ApiError("Unauthorized", 401, null))).toBe(false);
    expect(isReachabilityError(new Error("bad input"))).toBe(false);
  });

  it("retries only while unreachable, backing off to every 10 seconds", () => {
    expect(retryWhileUnreachable(50, offline())).toBe(true);
    expect(retryWhileUnreachable(0, new ApiError("Forbidden", 403, null))).toBe(false);
    expect([0, 1, 2, 3, 4, 9].map(reconnectRetryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });
});

describe("startConnectionRecovery", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    vi.useFakeTimers();
    ctx = setup();
  });
  afterEach(() => {
    ctx.cleanup();
    vi.useRealTimers();
  });

  async function failFirst() {
    await vi.waitFor(() => expect(ctx.observer.getCurrentResult().status).toBe("error"));
  }

  it("makes a failed request again by itself once the server answers (no reopening the app)", async () => {
    const stop = startConnectionRecovery(ctx.queryClient, ctx.deps);
    await failFirst();
    expect(ctx.state.fetches).toBe(1);

    // Still away: checked again, nothing refetched.
    await vi.advanceTimersByTimeAsync(RECONNECT_CHECK_DELAYS_MS[0]);
    expect(ctx.checks).toHaveBeenCalledTimes(1);
    expect(ctx.state.fetches).toBe(1);

    ctx.state.serverUp = true;
    await vi.advanceTimersByTimeAsync(RECONNECT_CHECK_DELAYS_MS[1]);
    await settle();
    await vi.waitFor(() => expect(ctx.observer.getCurrentResult().data).toEqual(["issue"]));
    expect(ctx.observer.getCurrentResult().status).toBe("success");
    stop();
  });

  it("checks right away when the network comes back, not at the next tick", async () => {
    const stop = startConnectionRecovery(ctx.queryClient, ctx.deps);
    await failFirst();
    ctx.state.serverUp = true;

    ctx.target.dispatchEvent(new Event("online"));
    await settle();
    await vi.waitFor(() => expect(ctx.observer.getCurrentResult().status).toBe("success"));
    expect(ctx.checks).toHaveBeenCalledTimes(1);
    stop();
  });

  it("refetches at once when the Automa app says its server is back", async () => {
    const stop = startConnectionRecovery(ctx.queryClient, ctx.deps);
    await failFirst();
    ctx.state.serverUp = true;

    ctx.target.dispatchEvent(new Event(SERVER_BACK_EVENT));
    await settle();
    await vi.waitFor(() => expect(ctx.observer.getCurrentResult().status).toBe("success"));
    // The app already checked: the page doesn't ask the server first.
    expect(ctx.checks).not.toHaveBeenCalled();
    stop();
  });

  it("checks when the page is shown again", async () => {
    const stop = startConnectionRecovery(ctx.queryClient, ctx.deps);
    await failFirst();
    ctx.state.serverUp = true;
    ctx.setVisible(true);

    ctx.target.dispatchEvent(new Event("visibilitychange"));
    await settle();
    await vi.waitFor(() => expect(ctx.observer.getCurrentResult().status).toBe("success"));
    stop();
  });

  it("backs off while the server stays away, to one check every 10 seconds", async () => {
    const stop = startConnectionRecovery(ctx.queryClient, ctx.deps);
    await failFirst();
    const total = RECONNECT_CHECK_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) + 10_000 * 3;
    await vi.advanceTimersByTimeAsync(total);
    expect(ctx.checks).toHaveBeenCalledTimes(RECONNECT_CHECK_DELAYS_MS.length + 3);
    stop();
  });

  it("leaves a request that got a real answer alone", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryFn = vi.fn(async () => {
      throw new ApiError("Not found", 404, null);
    });
    const observer = new QueryObserver(queryClient, { queryKey: ["missing"], queryFn });
    const unsubscribe = observer.subscribe(() => undefined);
    const stop = startConnectionRecovery(queryClient, { ...ctx.deps, checkServer: async () => true });
    await vi.waitFor(() => expect(observer.getCurrentResult().status).toBe("error"));

    await vi.advanceTimersByTimeAsync(60_000);
    ctx.target.dispatchEvent(new Event("online"));
    ctx.target.dispatchEvent(new Event(SERVER_BACK_EVENT));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);
    stop();
    unsubscribe();
    queryClient.clear();
  });

  it("stops checking and listening once stopped", async () => {
    const stop = startConnectionRecovery(ctx.queryClient, ctx.deps);
    await failFirst();
    stop();
    ctx.state.serverUp = true;
    ctx.target.dispatchEvent(new Event("online"));
    ctx.target.dispatchEvent(new Event(SERVER_BACK_EVENT));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.checks).not.toHaveBeenCalled();
    expect(ctx.state.fetches).toBe(1);
  });
});
