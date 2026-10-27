CREATE TABLE "moan_knowledge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"url" text NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"topic" text DEFAULT 'news' NOT NULL,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moan_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"pages" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "moan_knowledge_url_chunk_uq" ON "moan_knowledge" USING btree ("url","chunk_index");--> statement-breakpoint
CREATE INDEX "moan_knowledge_source_idx" ON "moan_knowledge" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "moan_knowledge_published_idx" ON "moan_knowledge" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "moan_knowledge_search_idx" ON "moan_knowledge" USING gin (to_tsvector('english', coalesce("title", '') || ' ' || "content"));