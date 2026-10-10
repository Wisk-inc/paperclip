CREATE TABLE "studio_ai_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"material" jsonb NOT NULL,
	"value_sha256" text NOT NULL,
	"last4" text NOT NULL,
	"base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"collaborator_id" uuid,
	"author_name" text NOT NULL,
	"message" text,
	"files" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_collaborators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"color" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_name" text NOT NULL,
	"collaborator_id" uuid,
	"body" text DEFAULT '' NOT NULL,
	"attachment" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"description" text,
	"source_url" text,
	"run_command" text,
	"created_by_user_id" text,
	"share_code" text,
	"share_enabled" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_ai_keys" ADD CONSTRAINT "studio_ai_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_change_requests" ADD CONSTRAINT "studio_change_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_change_requests" ADD CONSTRAINT "studio_change_requests_workspace_id_studio_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."studio_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_change_requests" ADD CONSTRAINT "studio_change_requests_collaborator_id_studio_collaborators_id_fk" FOREIGN KEY ("collaborator_id") REFERENCES "public"."studio_collaborators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_collaborators" ADD CONSTRAINT "studio_collaborators_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_collaborators" ADD CONSTRAINT "studio_collaborators_workspace_id_studio_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."studio_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_messages" ADD CONSTRAINT "studio_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_messages" ADD CONSTRAINT "studio_messages_workspace_id_studio_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."studio_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_messages" ADD CONSTRAINT "studio_messages_collaborator_id_studio_collaborators_id_fk" FOREIGN KEY ("collaborator_id") REFERENCES "public"."studio_collaborators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_workspaces" ADD CONSTRAINT "studio_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "studio_ai_keys_company_user_provider_uq" ON "studio_ai_keys" USING btree ("company_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "studio_change_requests_workspace_idx" ON "studio_change_requests" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "studio_collaborators_workspace_idx" ON "studio_collaborators" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_collaborators_token_hash_uq" ON "studio_collaborators" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "studio_messages_workspace_idx" ON "studio_messages" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "studio_workspaces_company_created_idx" ON "studio_workspaces" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_workspaces_share_code_uq" ON "studio_workspaces" USING btree ("share_code");