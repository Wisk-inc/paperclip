// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, QueryObserver, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_REFRESH_EVENT, refreshBoard } from "../lib/board-refresh";
import { RefreshButton } from "./RefreshButton";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("refreshBoard", () => {
  it("loads what is on screen again, marks the rest to load when shown, and tells the live updates", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const onScreen = vi.fn(async () => "tasks");
    const offScreen = vi.fn(async () => "costs");
    await client.fetchQuery({ queryKey: ["tasks"], queryFn: onScreen });
    await client.fetchQuery({ queryKey: ["costs"], queryFn: offScreen });
    // On screen: something observes it (a page's useQuery does the same).
    const unsubscribe = new QueryObserver(client, { queryKey: ["tasks"], queryFn: onScreen }).subscribe(() => undefined);
    const events: string[] = [];
    const target = { dispatchEvent: (event: Event) => { events.push(event.type); return true; } };

    await refreshBoard(client, target);

    expect(events).toEqual([BOARD_REFRESH_EVENT]);
    expect(onScreen).toHaveBeenCalledTimes(2);
    expect(offScreen).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(["costs"])?.isInvalidated).toBe(true);
    unsubscribe();
    client.clear();
  });

  it("does not fail when the server can't be reached: the board's reconnect takes over", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const unsubscribe = new QueryObserver(client, {
      queryKey: ["tasks"],
      queryFn: async () => {
        throw new TypeError("Failed to fetch");
      },
    }).subscribe(() => undefined);
    await expect(refreshBoard(client, { dispatchEvent: () => true })).resolves.toBeUndefined();
    unsubscribe();
    client.clear();
  });
});

describe("RefreshButton", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const read = vi.fn(async () => "first");

  beforeEach(() => {
    vi.useFakeTimers();
    read.mockReset();
    read.mockResolvedValueOnce("first").mockResolvedValue("second");
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    vi.useRealTimers();
  });

  function Page() {
    const { data } = useQuery({ queryKey: ["tasks"], queryFn: read });
    return <span data-testid="data">{data}</span>;
  }

  it("loads the page's data again, spins while it does, and tells the live updates to reconnect", async () => {
    const heard = vi.fn();
    window.addEventListener(BOARD_REFRESH_EVENT, heard);
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <Page />
        <RefreshButton />
      </QueryClientProvider>,
    ));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[data-testid="data"]')?.textContent).toBe("first");
    const button = container.querySelector<HTMLButtonElement>('[data-slot="refresh-button"]')!;
    expect(button.getAttribute("aria-label")).toBe("Refresh");

    await act(async () => button.click());
    expect(button.getAttribute("aria-label")).toBe("Refreshing");
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[data-testid="data"]')?.textContent).toBe("second");
    expect(heard).toHaveBeenCalledTimes(1);
    // A second tap while it spins does nothing more.
    await act(async () => button.click());
    expect(read).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(button.getAttribute("aria-label")).toBe("Refresh");
    window.removeEventListener(BOARD_REFRESH_EVENT, heard);
  });
});
