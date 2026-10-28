/**
 * Moan's knowledge service: keeps the Jamaican index filled on a schedule
 * while Moan is in use, and answers "what do we know about this question"
 * for each turn. One instance per database; the server starts its clock at
 * boot and stops it on shutdown.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { FREE_MODELS_ADAPTER_TYPE, MOAN_MODEL_ID, type MoanKnowledgeStatus } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { ingestSource } from "./ingest.js";
import { MOAN_SOURCES, type MoanSource } from "./sources.js";
import { knowledgeStats, recentKnowledge, searchAnyWord, searchKnowledge, type KnowledgeHit } from "./store.js";
import { formatContext, queryTerms, timeAgo } from "./text.js";

const TICK_MS = 10 * 60_000;
const FIRST_TICK_MS = 45_000;
const SOURCES_PER_TICK = 4;
const IN_USE_CACHE_MS = 5 * 60_000;
const USED_RECENTLY_MS = 24 * 60 * 60_000;
const RUN_TIMEOUT_MS = 8 * 60_000;

export interface MoanKnowledge {
  /** Starts the refresh clock (no-op when already started). */
  start(): void;
  stop(): void;
  status(): Promise<MoanKnowledgeStatus>;
  /** Refreshes due sources now (all sources with `force`) in the background. */
  refresh(options?: { force?: boolean }): Promise<{ started: boolean; sources: number }>;
  /** Retrieved passages and a freshness line for one question; empty when the index is empty or off. */
  contextFor(question: string): Promise<{ context: string; freshness: string }>;
  /** Notes that Moan just answered, which keeps the clock running for a day. */
  markUsed(): void;
}

function envSwitch(): boolean | null {
  const value = (process.env.PAPERCLIP_MOAN_KNOWLEDGE ?? "").trim().toLowerCase();
  if (["off", "0", "false", "no"].includes(value)) return false;
  if (["on", "1", "true", "yes", "always"].includes(value)) return true;
  return null;
}

function createMoanKnowledge(db: Db): MoanKnowledge {
  let timer: ReturnType<typeof setInterval> | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastTickAt: Date | null = null;
  let lastUsedAt = 0;
  let inUseCache: { until: number; value: boolean } | null = null;
  let controller: AbortController | null = null;

  const moanAgentsExist = async (): Promise<boolean> => {
    if (inUseCache && inUseCache.until > Date.now()) return inUseCache.value;
    let value = false;
    try {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agents)
        .where(and(eq(agents.adapterType, FREE_MODELS_ADAPTER_TYPE), ne(agents.status, "terminated"), sql`lower(${agents.adapterConfig} ->> 'model') = ${MOAN_MODEL_ID}`));
      value = Number(row?.count ?? 0) > 0;
    } catch (error) {
      logger.warn({ err: error }, "moan knowledge: could not check whether Moan is in use");
    }
    inUseCache = { until: Date.now() + IN_USE_CACHE_MS, value };
    return value;
  };

  const inUse = async (): Promise<boolean> => {
    if (Date.now() - lastUsedAt < USED_RECENTLY_MS) return true;
    return moanAgentsExist();
  };

  const enabled = async (): Promise<boolean> => {
    const forced = envSwitch();
    if (forced !== null) return forced;
    return inUse();
  };

  const dueSources = async (force: boolean): Promise<MoanSource[]> => {
    const stats = await knowledgeStats(db);
    const byId = new Map(stats.sources.map((source) => [source.id, source]));
    const now = Date.now();
    return MOAN_SOURCES.filter((source) => {
      if (force) return true;
      const row = byId.get(source.id);
      if (!row?.lastRunAt) return true;
      // A source that failed is tried again sooner than its own interval, but not every tick.
      const interval = row.lastError ? Math.min(source.everyMinutes, 60) : source.everyMinutes;
      return now - row.lastRunAt.getTime() >= interval * 60_000;
    });
  };

  const run = async (sources: MoanSource[]): Promise<void> => {
    if (running || !sources.length) return;
    running = true;
    controller = new AbortController();
    const signal = controller.signal;
    const stopAt = setTimeout(() => controller?.abort(), RUN_TIMEOUT_MS);
    try {
      for (const source of sources) {
        if (signal.aborted) break;
        const started = Date.now();
        const result = await ingestSource(db, source, signal);
        const seconds = Math.round((Date.now() - started) / 1000);
        if (result.error) logger.warn({ source: source.id, reason: result.error, seconds }, "moan knowledge: source failed");
        else logger.info({ source: source.id, items: result.items, stored: result.stored, seconds }, "moan knowledge: source refreshed");
      }
    } finally {
      clearTimeout(stopAt);
      running = false;
      controller = null;
      lastTickAt = new Date();
    }
  };

  const tick = async (): Promise<void> => {
    try {
      if (running || !(await enabled())) return;
      const due = await dueSources(false);
      // News first, so a short tick still brings the day in.
      const ordered = [...due].sort((a, b) => a.everyMinutes - b.everyMinutes).slice(0, SOURCES_PER_TICK);
      await run(ordered);
    } catch (error) {
      logger.error({ err: error }, "moan knowledge: tick failed");
    }
  };

  return {
    start() {
      if (timer || process.env.VITEST) return;
      firstTimer = setTimeout(() => { void tick(); }, FIRST_TICK_MS);
      firstTimer.unref?.();
      timer = setInterval(() => { void tick(); }, TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
      if (timer) { clearInterval(timer); timer = null; }
      controller?.abort();
    },
    async status() {
      const stats = await knowledgeStats(db);
      const byId = new Map(stats.sources.map((source) => [source.id, source]));
      const now = Date.now();
      return {
        enabled: await enabled(),
        inUse: await inUse(),
        running,
        pages: stats.pages,
        chunks: stats.chunks,
        lastFetchedAt: stats.lastFetchedAt?.toISOString() ?? null,
        lastTickAt: lastTickAt?.toISOString() ?? null,
        sources: MOAN_SOURCES.map((source) => {
          const row = byId.get(source.id);
          return {
            id: source.id,
            name: source.name,
            topic: source.topic,
            kind: source.kind,
            url: source.url,
            everyMinutes: source.everyMinutes,
            lastRunAt: row?.lastRunAt?.toISOString() ?? null,
            lastOkAt: row?.lastOkAt?.toISOString() ?? null,
            lastError: row?.lastError ?? null,
            pages: row?.pages ?? 0,
            due: !row?.lastRunAt || now - row.lastRunAt.getTime() >= source.everyMinutes * 60_000,
          };
        }),
      };
    },
    async refresh(options = {}) {
      if (running) return { started: false, sources: 0 };
      const sources = await dueSources(options.force === true);
      if (!sources.length) return { started: false, sources: 0 };
      lastUsedAt = Date.now();
      void run(sources).catch((error) => logger.error({ err: error }, "moan knowledge: refresh failed"));
      return { started: true, sources: sources.length };
    },
    async contextFor(question) {
      lastUsedAt = Date.now();
      const stats = await knowledgeStats(db);
      if (stats.pages === 0) {
        // First use: start filling right away rather than waiting for the clock.
        if (!running && (await enabled())) void this.refresh().catch((error) => logger.warn({ err: error }, "moan knowledge: first refresh failed"));
        return { context: "", freshness: "no pages yet; the Jamaican sources are being read in the background" };
      }
      const okSources = stats.sources.filter((source) => source.lastOkAt && source.pages > 0).length;
      const freshness = `${stats.pages.toLocaleString("en-US")} pages from ${okSources} Jamaican source${okSources === 1 ? "" : "s"}, refreshed ${timeAgo(stats.lastFetchedAt)}`;
      const hits: KnowledgeHit[] = [];
      const trimmed = question.trim();
      if (trimmed) {
        try { hits.push(...(await searchKnowledge(db, trimmed, 8))); } catch (error) { logger.warn({ err: error }, "moan knowledge: search failed"); }
        if (hits.length < 3) {
          const words = queryTerms(trimmed);
          if (words.length) {
            try { hits.push(...(await searchAnyWord(db, words, 8 - hits.length))); } catch (error) { logger.warn({ err: error }, "moan knowledge: word search failed"); }
          }
        }
      }
      let recent: KnowledgeHit[] = [];
      try { recent = await recentKnowledge(db, 4); } catch { /* the index is a bonus, never a blocker */ }
      const names = new Map(MOAN_SOURCES.map((source) => [source.id, source.name]));
      const context = formatContext([...hits, ...recent].map((hit) => ({ sourceName: names.get(hit.sourceId) ?? hit.sourceId, url: hit.url, title: hit.title, publishedAt: hit.publishedAt, content: hit.content })));
      return { context, freshness };
    },
    markUsed() { lastUsedAt = Date.now(); },
  };
}

const instances = new WeakMap<object, MoanKnowledge>();

/** The knowledge service for this database (one per process). */
export function moanKnowledge(db: Db): MoanKnowledge {
  let instance = instances.get(db as object);
  if (!instance) {
    instance = createMoanKnowledge(db);
    instances.set(db as object, instance);
  }
  return instance;
}
