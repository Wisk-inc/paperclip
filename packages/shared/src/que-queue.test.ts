import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUE_MAX_IN_FLIGHT, QUE_PER_MODEL_IN_FLIGHT } from "./que.js";
import { queQueueStats, queTurn, resetQueQueueStats, type QueRelease } from "./que-queue.js";

const turns = (model: string | undefined, count: number) => Promise.all(Array.from({ length: count }, () => queTurn(undefined, model)));
const endAll = (releases: QueRelease[]) => releases.forEach((release) => release());

beforeEach(() => resetQueQueueStats());
afterEach(() => {
  vi.useRealTimers();
  // Every test hands back what it took, so the next one starts from an empty queue.
  expect(queQueueStats()).toMatchObject({ inFlight: 0, waiting: 0 });
});

describe("Que queue limits", () => {
  it("lets other models run while one model is full, and gives that model's next slot to its oldest waiter", async () => {
    const a = await turns("a", QUE_PER_MODEL_IN_FLIGHT);
    const order: string[] = [];
    const a3 = queTurn(undefined, "a").then((release) => (order.push("a3"), release));
    const b = await queTurn(undefined, "b");
    expect(queQueueStats()).toMatchObject({ inFlight: QUE_PER_MODEL_IN_FLIGHT + 1, waiting: 1 });
    const a4 = queTurn(undefined, "a").then((release) => (order.push("a4"), release));
    a[0]!();
    const third = await a3;
    expect(order).toEqual(["a3"]);
    a[1]!();
    const fourth = await a4;
    expect(order).toEqual(["a3", "a4"]);
    endAll([third, fourth, b]);
  });

  it("keeps the global limit across models, and starts the oldest waiter whose model has room", async () => {
    const held: Record<string, QueRelease[]> = {};
    for (let m = 0; m < QUE_MAX_IN_FLIGHT / QUE_PER_MODEL_IN_FLIGHT; m += 1) held[`m${m}`] = await turns(`m${m}`, QUE_PER_MODEL_IN_FLIGHT);
    expect(queQueueStats()).toMatchObject({ inFlight: QUE_MAX_IN_FLIGHT, peakInFlight: QUE_MAX_IN_FLIGHT });
    const order: string[] = [];
    const wait = (model: string, name: string) => queTurn(undefined, model).then((release) => (order.push(name), release));
    const m0First = wait("m0", "m0-first");
    const fresh = wait("n", "n");
    const m0Second = wait("m0", "m0-second");
    expect(queQueueStats().waiting).toBe(3);

    held.m1!.pop()!(); // a global slot frees: m0 is still full, so "n" goes ahead
    const n = await fresh;
    expect(order).toEqual(["n"]);
    held.m0!.pop()!(); // now m0 has room: its oldest waiter goes
    const first = await m0First;
    held.m2!.pop()!(); // a global slot, but m0 is full again: nobody can start
    await Promise.resolve();
    expect(order).toEqual(["n", "m0-first"]);
    expect(queQueueStats()).toMatchObject({ inFlight: QUE_MAX_IN_FLIGHT - 1, waiting: 1 });
    held.m0!.pop()!();
    const second = await m0Second;
    expect(order).toEqual(["n", "m0-first", "m0-second"]);
    expect(queQueueStats().peakInFlight).toBe(QUE_MAX_IN_FLIGHT);
    endAll([n, first, second, ...Object.values(held).flat()]);
  });

  it("counts a call without a model toward the global limit only", async () => {
    const a = await turns("a", QUE_PER_MODEL_IN_FLIGHT);
    const waitingForA = queTurn(undefined, "a");
    const rest = await turns(undefined, QUE_MAX_IN_FLIGHT - QUE_PER_MODEL_IN_FLIGHT);
    expect(queQueueStats()).toMatchObject({ inFlight: QUE_MAX_IN_FLIGHT, waiting: 1 });
    let started = false;
    const extra = queTurn().then((release) => ((started = true), release));
    await Promise.resolve();
    expect(started).toBe(false);
    rest[0]!(); // model "a" is still full, so the call without a model takes the place
    const last = await extra;
    a[0]!();
    const nextA = await waitingForA;
    endAll([last, nextA, a[1]!, ...rest.slice(1)]);
  });
});

describe("Que queue leaving and ending", () => {
  it("refuses an already-aborted call at once with the abort's reason, without taking a turn", async () => {
    const controller = new AbortController();
    const reason = new Error("left");
    controller.abort(reason);
    await expect(queTurn(controller.signal, "a")).rejects.toBe(reason);
    expect(queQueueStats()).toMatchObject({ inFlight: 0, started: 0 });
  });

  it("lets a waiter that gives up leave the line, and the slot goes to the next one", async () => {
    const a = await turns("a", QUE_PER_MODEL_IN_FLIGHT);
    const controller = new AbortController();
    const leaving = queTurn(controller.signal, "a");
    const staying = queTurn(undefined, "a");
    controller.abort();
    await expect(leaving).rejects.toThrow(/abort/i);
    expect(queQueueStats().waiting).toBe(1);
    a[0]!();
    const next = await staying;
    expect(queQueueStats()).toMatchObject({ inFlight: QUE_PER_MODEL_IN_FLIGHT, waiting: 0, started: QUE_PER_MODEL_IN_FLIGHT + 1 });
    endAll([next, a[1]!]);
  });

  it("stops listening for abort once a waiter gets its turn, so a later abort changes nothing", async () => {
    const a = await turns("a", QUE_PER_MODEL_IN_FLIGHT);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = queTurn(controller.signal, "a");
    a[0]!();
    const release = await waiting;
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
    controller.abort();
    expect(queQueueStats().inFlight).toBe(QUE_PER_MODEL_IN_FLIGHT);
    endAll([release, a[1]!]);
  });

  it("frees one place when a turn is ended twice, for the model and overall", async () => {
    const a = await turns("a", QUE_PER_MODEL_IN_FLIGHT);
    a[0]!();
    a[0]!();
    expect(queQueueStats().inFlight).toBe(QUE_PER_MODEL_IN_FLIGHT - 1);
    // The model has exactly one place again, not two.
    const one = await queTurn(undefined, "a");
    let more = false;
    const another = queTurn(undefined, "a").then((release) => ((more = true), release));
    await Promise.resolve();
    expect(more).toBe(false);
    a[1]!();
    endAll([one, await another]);
  });

  it("ends a turn its holder never ended after ten minutes, once, without upsetting the counts", async () => {
    vi.useFakeTimers();
    const a = await turns("a", QUE_PER_MODEL_IN_FLIGHT);
    let started = false;
    const waiting = queTurn(undefined, "a").then((release) => ((started = true), release));
    vi.advanceTimersByTime(10 * 60_000 - 1);
    await Promise.resolve();
    expect(started).toBe(false);
    vi.advanceTimersByTime(1);
    const late = await waiting;
    expect(queQueueStats()).toMatchObject({ inFlight: 1, waiting: 0 });
    // The holders ending late changes nothing: their places were already given back.
    endAll(a);
    expect(queQueueStats().inFlight).toBe(1);
    late();
  });

  it("clears a turn's ten-minute timer when its holder ends it", async () => {
    vi.useFakeTimers();
    const release = await queTurn(undefined, "a");
    expect(vi.getTimerCount()).toBe(1);
    release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a turn its holder keeps refreshing past ten minutes, while a turn nobody refreshes still ends itself", async () => {
    vi.useFakeTimers();
    const live = await queTurn(undefined, "a");
    const stuck = await queTurn(undefined, "b");
    for (let minute = 1; minute <= 30; minute += 1) {
      vi.advanceTimersByTime(60_000);
      live.refresh();
    }
    expect(queQueueStats().inFlight).toBe(1);
    // Ten minutes after the last refresh, the live turn ends itself too.
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(queQueueStats().inFlight).toBe(1);
    vi.advanceTimersByTime(1);
    expect(queQueueStats().inFlight).toBe(0);
    endAll([live, stuck]);
    expect(queQueueStats().inFlight).toBe(0);
  });

  it("does nothing when a turn is refreshed after it ended, by its holder or by its time limit", async () => {
    vi.useFakeTimers();
    const ended = await queTurn(undefined, "a");
    ended();
    ended.refresh();
    const expired = await queTurn(undefined, "a");
    vi.advanceTimersByTime(10 * 60_000);
    expired.refresh();
    expect(vi.getTimerCount()).toBe(0);
    expect(queQueueStats().inFlight).toBe(0);
    expired();
  });
});
