/**
 * Moan's knowledge index in the database: pages cut into chunks, searched
 * with Postgres full-text search, plus a status row per source.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { moanKnowledge, moanSources, type Db } from "@paperclipai/db";
import type { MoanTopic } from "./sources.js";

export interface KnowledgeHit {
  sourceId: string;
  url: string;
  title: string;
  topic: string;
  publishedAt: Date | null;
  content: string;
  rank: number;
}

/** Raw query rows, whichever driver answered (an array, or `{ rows }`). */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = result as { rows?: T[] } | null;
  return Array.isArray(wrapped?.rows) ? wrapped.rows : [];
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

type RawHit = { source_id: string; url: string; title: string; topic: string; published_at: unknown; content: string; rank?: unknown };

function toHit(row: RawHit): KnowledgeHit {
  return { sourceId: row.source_id, url: row.url, title: row.title ?? "", topic: row.topic, publishedAt: asDate(row.published_at), content: row.content, rank: Number(row.rank ?? 0) };
}

/** The same expression the GIN index is built on. */
const DOCUMENT = sql`to_tsvector('english', coalesce("title", '') || ' ' || "content")`;

export async function storedPage(db: Db, url: string): Promise<{ fetchedAt: Date; contentHash: string } | null> {
  const [row] = await db
    .select({ fetchedAt: moanKnowledge.fetchedAt, contentHash: moanKnowledge.contentHash })
    .from(moanKnowledge)
    .where(and(eq(moanKnowledge.url, url), eq(moanKnowledge.chunkIndex, 0)))
    .limit(1);
  return row ?? null;
}

export interface PageToStore {
  sourceId: string;
  url: string;
  title: string;
  topic: MoanTopic;
  publishedAt: Date | null;
  chunks: string[];
  contentHash: string;
}

/** Stores a page's chunks, replacing what was there; "unchanged" when the content hash matches and only the fetch time moves. */
export async function replacePage(db: Db, page: PageToStore): Promise<"stored" | "unchanged" | "empty"> {
  if (!page.chunks.length) return "empty";
  const existing = await storedPage(db, page.url);
  const now = new Date();
  if (existing && existing.contentHash === page.contentHash) {
    await db.update(moanKnowledge).set({ fetchedAt: now }).where(eq(moanKnowledge.url, page.url));
    return "unchanged";
  }
  await db.transaction(async (tx) => {
    await tx.delete(moanKnowledge).where(eq(moanKnowledge.url, page.url));
    await tx.insert(moanKnowledge).values(page.chunks.map((content, chunkIndex) => ({
      sourceId: page.sourceId,
      url: page.url,
      chunkIndex,
      title: page.title.slice(0, 500),
      topic: page.topic,
      publishedAt: page.publishedAt,
      fetchedAt: now,
      content,
      contentHash: page.contentHash,
    })));
  });
  return "stored";
}

/** Full-text search with Postgres' web-search syntax (every word must match, phrases in quotes). */
export async function searchKnowledge(db: Db, query: string, limit = 8): Promise<KnowledgeHit[]> {
  const text = query.replace(/[^\p{L}\p{N}\s"'-]/gu, " ").trim();
  if (!text) return [];
  const result = await db.execute(sql`
    select source_id, url, title, topic, published_at, content,
      ts_rank_cd(${DOCUMENT}, websearch_to_tsquery('english', ${text})) as rank
    from moan_knowledge
    where ${DOCUMENT} @@ websearch_to_tsquery('english', ${text})
    order by rank desc, published_at desc nulls last
    limit ${limit}
  `);
  return rowsOf<RawHit>(result).map(toHit);
}

/** Looser search: any of the words, best matches first. */
export async function searchAnyWord(db: Db, words: string[], limit = 8): Promise<KnowledgeHit[]> {
  const clean = words.map((word) => word.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  if (!clean.length) return [];
  const query = clean.join(" | ");
  const result = await db.execute(sql`
    select source_id, url, title, topic, published_at, content,
      ts_rank_cd(${DOCUMENT}, to_tsquery('english', ${query})) as rank
    from moan_knowledge
    where ${DOCUMENT} @@ to_tsquery('english', ${query})
    order by rank desc, published_at desc nulls last
    limit ${limit}
  `);
  return rowsOf<RawHit>(result).map(toHit);
}

/** The newest pages (first chunk each) in the given topics. */
export async function recentKnowledge(db: Db, limit = 5, topics: string[] = ["news", "government", "weather"]): Promise<KnowledgeHit[]> {
  const rows = await db
    .select({ source_id: moanKnowledge.sourceId, url: moanKnowledge.url, title: moanKnowledge.title, topic: moanKnowledge.topic, published_at: moanKnowledge.publishedAt, content: moanKnowledge.content })
    .from(moanKnowledge)
    .where(and(eq(moanKnowledge.chunkIndex, 0), inArray(moanKnowledge.topic, topics), sql`${moanKnowledge.publishedAt} is not null`))
    .orderBy(desc(moanKnowledge.publishedAt))
    .limit(limit);
  return rows.map((row) => toHit(row as RawHit));
}

export interface KnowledgeStats {
  pages: number;
  chunks: number;
  lastFetchedAt: Date | null;
  sources: Array<{ id: string; lastRunAt: Date | null; lastOkAt: Date | null; lastError: string | null; pages: number }>;
}

export async function knowledgeStats(db: Db): Promise<KnowledgeStats> {
  const [totals] = await db
    .select({
      pages: sql<number>`count(distinct ${moanKnowledge.url})::int`,
      chunks: sql<number>`count(*)::int`,
      lastFetchedAt: sql<Date | string | null>`max(${moanKnowledge.fetchedAt})`,
    })
    .from(moanKnowledge);
  const sources = await db.select().from(moanSources);
  return {
    pages: Number(totals?.pages ?? 0),
    chunks: Number(totals?.chunks ?? 0),
    lastFetchedAt: asDate(totals?.lastFetchedAt ?? null),
    sources: sources.map((row) => ({ id: row.id, lastRunAt: row.lastRunAt, lastOkAt: row.lastOkAt, lastError: row.lastError, pages: row.pages })),
  };
}

/** Records a source's latest run. */
export async function touchSource(db: Db, id: string, patch: { ok: boolean; error?: string | null; pages?: number }): Promise<void> {
  const now = new Date();
  const values = {
    id,
    lastRunAt: now,
    lastOkAt: patch.ok ? now : undefined,
    lastError: patch.ok ? null : (patch.error ?? "failed"),
    pages: patch.pages,
    updatedAt: now,
  };
  await db
    .insert(moanSources)
    .values({ id, lastRunAt: now, lastOkAt: patch.ok ? now : null, lastError: values.lastError, pages: patch.pages ?? 0, updatedAt: now })
    .onConflictDoUpdate({
      target: moanSources.id,
      set: {
        lastRunAt: now,
        ...(patch.ok ? { lastOkAt: now } : {}),
        lastError: values.lastError,
        ...(patch.pages === undefined ? {} : { pages: patch.pages }),
        updatedAt: now,
      },
    });
}

/** How many distinct pages a source has in the index. */
export async function sourcePageCount(db: Db, sourceId: string): Promise<number> {
  const [row] = await db
    .select({ pages: sql<number>`count(distinct ${moanKnowledge.url})::int` })
    .from(moanKnowledge)
    .where(eq(moanKnowledge.sourceId, sourceId));
  return Number(row?.pages ?? 0);
}
