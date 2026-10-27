import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Moan's Jamaican knowledge index. Instance-level on purpose: it holds only
// public pages fetched from Jamaican news, government, law and reference
// sites (no company or user data), and every company's Moan agent reads the
// same island. See doc/moan.md.
export const moanSources = pgTable("moan_sources", {
  /** The source key from the server's source list (for example "jis-news"). */
  id: text("id").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastError: text("last_error"),
  pages: integer("pages").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const moanKnowledge = pgTable(
  "moan_knowledge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: text("source_id").notNull(),
    url: text("url").notNull(),
    chunkIndex: integer("chunk_index").notNull().default(0),
    title: text("title").notNull().default(""),
    /** news, government, law, history, economy, culture, weather. */
    topic: text("topic").notNull().default("news"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => ({
    urlChunkUq: uniqueIndex("moan_knowledge_url_chunk_uq").on(table.url, table.chunkIndex),
    sourceIdx: index("moan_knowledge_source_idx").on(table.sourceId),
    publishedIdx: index("moan_knowledge_published_idx").on(table.publishedAt),
    searchIdx: index("moan_knowledge_search_idx").using(
      "gin",
      sql`to_tsvector('english', coalesce(${table.title}, '') || ' ' || ${table.content})`,
    ),
  }),
);
