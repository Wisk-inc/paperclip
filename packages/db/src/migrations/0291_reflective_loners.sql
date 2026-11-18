CREATE TABLE "user_language_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"language" text DEFAULT 'auto' NOT NULL,
	"detected_language" text,
	"detected_locale" text,
	"country" text,
	"time_zone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_language_preferences_user_uq" ON "user_language_preferences" USING btree ("user_id");