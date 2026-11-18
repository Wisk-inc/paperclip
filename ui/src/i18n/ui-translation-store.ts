import type { AppLanguageCode } from "@paperclipai/shared";

/**
 * The translations of the board's text for one language: the ones Automa
 * ships (built in, always there), then the ones the free models made on the
 * server (saved there for everyone, and on this device for next time). Board
 * strings seen without a translation are asked for in small batches, once
 * the person is signed in (the server only translates for board users).
 */

/** Strings one request asks for (the server takes 80). */
export const UI_TRANSLATION_REQUEST_SIZE = 60;
/** A string the server could not translate yet is asked for again after this long. */
export const UI_TRANSLATION_RETRY_MS = 2 * 60_000;
/** Strings seen together on a screen are gathered this long, then asked for at once. */
export const UI_TRANSLATION_QUEUE_DELAY_MS = 300;
/** Saved on the device up to this size (characters); past it, the server's copy is enough. */
export const UI_TRANSLATION_DEVICE_CACHE_MAX = 600_000;

export interface UiTranslationStoreDeps {
  /** The translations Automa ships for the language (English source → translation). */
  builtin: (language: AppLanguageCode) => Promise<Record<string, string>>;
  /** Every translation the server has saved for the language. */
  fetchAll: (language: AppLanguageCode) => Promise<Record<string, string>>;
  translate: (language: AppLanguageCode, strings: string[]) => Promise<{ translations: Record<string, string>; pending: string[] }>;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => number;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { status?: unknown }).status === 404);
}

export function deviceCacheKey(language: AppLanguageCode): string {
  return `automa:ui-translations:v1:${language}`;
}

export class UiTranslationStore {
  private readonly builtin = new Map<string, string>();
  private readonly ai = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly queue = new Set<string>();
  private readonly askedAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private closed = false;
  private loading: Promise<void> | null = null;
  private connecting: Promise<void> | null = null;
  /** Signed in, and the server has the translation endpoint: AI translations can be asked for. */
  private online = false;

  constructor(
    readonly language: AppLanguageCode,
    private readonly deps: UiTranslationStoreDeps,
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  lookup(source: string): string | undefined {
    return this.builtin.get(source) ?? this.ai.get(source);
  }

  /** Translations known (built in and AI). */
  get size(): number {
    let count = this.builtin.size;
    for (const source of this.ai.keys()) if (!this.builtin.has(source)) count += 1;
    return count;
  }

  /** Whether AI translations are being asked for (signed in, server able). */
  get connected(): boolean {
    return this.online;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener();
  }

  /** The built-in translations and this device's saved copy: no network. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        for (const [source, text] of Object.entries(await this.deps.builtin(this.language))) {
          if (typeof text === "string" && text) this.builtin.set(source, text);
        }
      } catch {
        // A missing built-in file leaves the AI translations.
      }
      try {
        const saved = JSON.parse(this.deps.storage?.getItem(deviceCacheKey(this.language)) ?? "{}") as Record<string, unknown>;
        for (const [source, text] of Object.entries(saved)) if (typeof text === "string" && text) this.ai.set(source, text);
      } catch {
        // A damaged device copy is ignored; the server has the translations too.
      }
      this.notify();
    })();
    return this.loading;
  }

  /**
   * Signed in: the server's saved translations, and from then on the missing
   * ones are asked for. A server without the endpoint (older than 1.9.14)
   * leaves the built-in ones.
   */
  connect(): Promise<void> {
    this.connecting ??= (async () => {
      await this.load();
      if (this.closed) return;
      try {
        this.merge(await this.deps.fetchAll(this.language));
      } catch (error) {
        if (isNotFound(error)) return;
        // Unreachable now: translations are still asked for, and saved when they come.
      }
      if (this.closed) return;
      this.online = true;
      this.schedule();
    })();
    return this.connecting;
  }

  private merge(translations: Record<string, string>): void {
    let changed = false;
    for (const [source, text] of Object.entries(translations)) {
      if (typeof text !== "string" || !text || this.ai.get(source) === text) continue;
      this.ai.set(source, text);
      changed = true;
    }
    if (!changed) return;
    this.save();
    this.notify();
  }

  private save(): void {
    try {
      const json = JSON.stringify(Object.fromEntries(this.ai));
      if (json.length <= UI_TRANSLATION_DEVICE_CACHE_MAX) this.deps.storage?.setItem(deviceCacheKey(this.language), json);
    } catch {
      // Private mode or a full device: the server keeps them.
    }
  }

  /** Board strings on screen without a translation: asked for shortly, a batch at a time. */
  request(sources: readonly string[]): void {
    if (this.closed) return;
    const now = this.now();
    for (const source of sources) {
      if (this.lookup(source) !== undefined || this.queue.has(source)) continue;
      const asked = this.askedAt.get(source);
      if (asked !== undefined && now - asked < UI_TRANSLATION_RETRY_MS) continue;
      this.queue.add(source);
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.online || this.timer || this.busy || this.queue.size === 0 || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, UI_TRANSLATION_QUEUE_DELAY_MS);
  }

  private async flush(): Promise<void> {
    if (this.busy || this.closed || !this.online) return;
    const batch: string[] = [];
    for (const source of this.queue) {
      if (batch.length >= UI_TRANSLATION_REQUEST_SIZE) break;
      this.queue.delete(source);
      // Translated meanwhile (built in, or another request brought it).
      if (this.lookup(source) !== undefined) continue;
      this.askedAt.set(source, this.now());
      batch.push(source);
    }
    if (batch.length === 0) return;
    this.busy = true;
    try {
      this.merge((await this.deps.translate(this.language, batch)).translations);
    } catch (error) {
      // An older server: no AI translations, built-in ones only.
      if (isNotFound(error)) this.online = false;
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  /** Stops asking and telling (the language changed). */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.clear();
    this.listeners.clear();
  }
}
