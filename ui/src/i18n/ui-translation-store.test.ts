import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UI_TRANSLATION_QUEUE_DELAY_MS,
  UI_TRANSLATION_REQUEST_SIZE,
  UI_TRANSLATION_RETRY_MS,
  UiTranslationStore,
  deviceCacheKey,
  type UiTranslationStoreDeps,
} from "./ui-translation-store";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

function notFound() {
  return Object.assign(new Error("Not found"), { status: 404 });
}

let now = 0;
let storage: MemoryStorage;
let deps: UiTranslationStoreDeps & {
  builtin: ReturnType<typeof vi.fn>;
  fetchAll: ReturnType<typeof vi.fn>;
  translate: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  storage = new MemoryStorage();
  deps = {
    builtin: vi.fn(async () => ({ "Sign out": "Cerrar sesión" })),
    fetchAll: vi.fn(async () => ({ Settings: "Ajustes" })),
    translate: vi.fn(async (_language: string, strings: string[]) => ({
      translations: Object.fromEntries(strings.map((text) => [text, `ES:${text}`])),
      pending: [],
    })),
    storage,
    now: () => now,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushQueue() {
  await vi.advanceTimersByTimeAsync(UI_TRANSLATION_QUEUE_DELAY_MS + 1);
}

describe("UiTranslationStore", () => {
  it("has the built-in translations and this device's saved ones without the network", async () => {
    storage.setItem(deviceCacheKey("es"), JSON.stringify({ "New task": "Nueva tarea", broken: 5 }));
    const store = new UiTranslationStore("es", deps);
    await store.load();
    expect(store.lookup("Sign out")).toBe("Cerrar sesión");
    expect(store.lookup("New task")).toBe("Nueva tarea");
    expect(store.lookup("broken")).toBeUndefined();
    expect(deps.fetchAll).not.toHaveBeenCalled();
    expect(store.connected).toBe(false);
  });

  it("built-in translations win over AI ones for the same string", async () => {
    deps.fetchAll.mockResolvedValueOnce({ "Sign out": "Salir" });
    const store = new UiTranslationStore("es", deps);
    await store.connect();
    expect(store.lookup("Sign out")).toBe("Cerrar sesión");
  });

  it("asks for nothing before it is connected (signed out: built-in only)", async () => {
    const store = new UiTranslationStore("es", deps);
    await store.load();
    store.request(["Projects"]);
    await flushQueue();
    expect(deps.translate).not.toHaveBeenCalled();
  });

  it("connected: gets the server's saved translations and asks for missing ones in batches", async () => {
    const store = new UiTranslationStore("es", deps);
    const changed = vi.fn();
    store.onChange(changed);
    await store.connect();
    expect(store.lookup("Settings")).toBe("Ajustes");
    const many = Array.from({ length: UI_TRANSLATION_REQUEST_SIZE + 5 }, (_, n) => `String ${n}`);
    // Already translated strings and repeats are not asked for.
    store.request(["Sign out", "Settings", ...many, "String 0"]);
    await flushQueue();
    expect(deps.translate).toHaveBeenCalledTimes(1);
    expect(deps.translate.mock.calls[0]![1]).toHaveLength(UI_TRANSLATION_REQUEST_SIZE);
    await flushQueue();
    expect(deps.translate).toHaveBeenCalledTimes(2);
    expect(deps.translate.mock.calls[1]![1]).toHaveLength(5);
    expect(store.lookup("String 64")).toBe("ES:String 64");
    expect(changed).toHaveBeenCalled();
    // Saved on the device for next time.
    expect(JSON.parse(storage.getItem(deviceCacheKey("es"))!)["String 3"]).toBe("ES:String 3");
  });

  it("asks again for a string the server could not translate, but not right away", async () => {
    deps.translate.mockResolvedValue({ translations: {}, pending: ["Projects"] });
    const store = new UiTranslationStore("es", deps);
    await store.connect();
    store.request(["Projects"]);
    await flushQueue();
    store.request(["Projects"]);
    await flushQueue();
    expect(deps.translate).toHaveBeenCalledTimes(1);
    now += UI_TRANSLATION_RETRY_MS + 1;
    store.request(["Projects"]);
    await flushQueue();
    expect(deps.translate).toHaveBeenCalledTimes(2);
  });

  it("a server without translations (older than 1.9.14) leaves the built-in ones", async () => {
    deps.fetchAll.mockRejectedValueOnce(notFound());
    const store = new UiTranslationStore("es", deps);
    await store.connect();
    expect(store.connected).toBe(false);
    store.request(["Projects"]);
    await flushQueue();
    expect(deps.translate).not.toHaveBeenCalled();
    expect(store.lookup("Sign out")).toBe("Cerrar sesión");
  });

  it("stops asking when the translate endpoint is missing", async () => {
    deps.translate.mockRejectedValueOnce(notFound());
    const store = new UiTranslationStore("es", deps);
    await store.connect();
    store.request(["Projects"]);
    await flushQueue();
    store.request(["Agents"]);
    await flushQueue();
    expect(deps.translate).toHaveBeenCalledTimes(1);
    expect(store.connected).toBe(false);
  });

  it("a failed request is tried again later; an unreachable server at connect still allows asking", async () => {
    deps.fetchAll.mockRejectedValueOnce(Object.assign(new Error("offline"), { status: 0 }));
    deps.translate.mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 503 }));
    const store = new UiTranslationStore("es", deps);
    await store.connect();
    expect(store.connected).toBe(true);
    store.request(["Projects"]);
    await flushQueue();
    now += UI_TRANSLATION_RETRY_MS + 1;
    store.request(["Projects"]);
    await flushQueue();
    expect(deps.translate).toHaveBeenCalledTimes(2);
    expect(store.lookup("Projects")).toBe("ES:Projects");
  });

  it("closed (the language changed): no more requests or notices", async () => {
    const store = new UiTranslationStore("es", deps);
    const changed = vi.fn();
    store.onChange(changed);
    await store.connect();
    changed.mockClear();
    store.request(["Projects"]);
    store.close();
    await flushQueue();
    expect(deps.translate).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not fill the device past its limit", async () => {
    const huge = Object.fromEntries(Array.from({ length: 20_000 }, (_, n) => [`String number ${n}`, `Cadena número ${n} ${"x".repeat(20)}`]));
    deps.fetchAll.mockResolvedValueOnce(huge);
    const store = new UiTranslationStore("es", deps);
    await store.connect();
    expect(store.lookup("String number 5")).toContain("Cadena número 5");
    expect(storage.getItem(deviceCacheKey("es"))).toBeNull();
  });
});
