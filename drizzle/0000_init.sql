CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'running', 'completed');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'sending', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TYPE "public"."provider_event_result" AS ENUM('applied', 'ignored', 'pending');--> statement-breakpoint
CREATE TYPE "public"."provider_event_status" AS ENUM('delivered', 'read', 'failed');--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"template" varchar(4096) NOT NULL,
	"variables" text[] DEFAULT '{}' NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"rejected_contacts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"campaign_id" uuid NOT NULL,
	"phone" varchar(20) NOT NULL,
	"variables" jsonb NOT NULL,
	"status" "message_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"provider_message_id" varchar(255),
	"failure_reason" varchar(100),
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_provider_message_id_unique" UNIQUE("provider_message_id"),
	CONSTRAINT "messages_campaign_id_phone_unique" UNIQUE("campaign_id","phone")
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"event_id" varchar(255) PRIMARY KEY NOT NULL,
	"provider_message_id" varchar(255) NOT NULL,
	"status" "provider_event_status" NOT NULL,
	"result" "provider_event_result" DEFAULT 'pending' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_campaign_id_status_seq_idx" ON "messages" USING btree ("campaign_id","status","seq");--> statement-breakpoint
CREATE INDEX "messages_ready_queue_idx" ON "messages" USING btree ("next_attempt_at","seq") WHERE "messages"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "provider_events_provider_message_id_idx" ON "provider_events" USING btree ("provider_message_id");