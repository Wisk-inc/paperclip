ALTER TABLE "cost_events" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "source" text DEFAULT 'agent' NOT NULL;