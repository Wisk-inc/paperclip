CREATE TABLE "company_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text DEFAULT 'web' NOT NULL,
	"client_key" text NOT NULL,
	"registered_by_user_id" text,
	"shared_folder_name" text,
	"shared_index" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shared_index_updated_at" timestamp with time zone,
	"auto_fulfill" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_file_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"device_id" uuid,
	"issue_id" uuid,
	"title" text NOT NULL,
	"details" text,
	"device_path" text,
	"accept_types" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"fulfilled_file_id" uuid,
	"resolved_by_user_id" text,
	"resolved_by_device_id" uuid,
	"response_note" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"source_device_id" uuid,
	"target_device_id" uuid,
	"issue_id" uuid,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"device_path" text,
	"note" text,
	"uploaded_by_agent_id" uuid,
	"uploaded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_devices" ADD CONSTRAINT "company_devices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_file_requests" ADD CONSTRAINT "device_file_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_file_requests" ADD CONSTRAINT "device_file_requests_device_id_company_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."company_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_file_requests" ADD CONSTRAINT "device_file_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_file_requests" ADD CONSTRAINT "device_file_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_file_requests" ADD CONSTRAINT "device_file_requests_fulfilled_file_id_device_files_id_fk" FOREIGN KEY ("fulfilled_file_id") REFERENCES "public"."device_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_file_requests" ADD CONSTRAINT "device_file_requests_resolved_by_device_id_company_devices_id_fk" FOREIGN KEY ("resolved_by_device_id") REFERENCES "public"."company_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_files" ADD CONSTRAINT "device_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_files" ADD CONSTRAINT "device_files_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_files" ADD CONSTRAINT "device_files_source_device_id_company_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."company_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_files" ADD CONSTRAINT "device_files_target_device_id_company_devices_id_fk" FOREIGN KEY ("target_device_id") REFERENCES "public"."company_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_files" ADD CONSTRAINT "device_files_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_files" ADD CONSTRAINT "device_files_uploaded_by_agent_id_agents_id_fk" FOREIGN KEY ("uploaded_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_devices_company_created_idx" ON "company_devices" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "company_devices_company_client_key_uq" ON "company_devices" USING btree ("company_id","client_key");--> statement-breakpoint
CREATE INDEX "device_file_requests_company_status_created_idx" ON "device_file_requests" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "device_file_requests_company_device_idx" ON "device_file_requests" USING btree ("company_id","device_id");--> statement-breakpoint
CREATE INDEX "device_files_company_created_idx" ON "device_files" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "device_files_company_source_idx" ON "device_files" USING btree ("company_id","source_device_id");--> statement-breakpoint
CREATE INDEX "device_files_company_target_idx" ON "device_files" USING btree ("company_id","target_device_id");