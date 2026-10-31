CREATE TYPE "public"."file_status" AS ENUM('pending_upload', 'queued', 'processing', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"name" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"day" date NOT NULL,
	"platform" text NOT NULL,
	"uploads" integer NOT NULL,
	"ready" integer NOT NULL,
	"failed" integer NOT NULL,
	"bytes_in" bigint NOT NULL,
	"p50_processing_ms" integer,
	"p95_processing_ms" integer,
	CONSTRAINT "daily_stats_day_platform_pk" PRIMARY KEY("day","platform")
);
--> statement-breakpoint
CREATE TABLE "file_variants" (
	"file_id" uuid NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"bytes" integer NOT NULL,
	CONSTRAINT "file_variants_file_id_size_pk" PRIMARY KEY("file_id","size")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"api_key_id" uuid,
	"status" "file_status" DEFAULT 'pending_upload' NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer,
	"width" integer,
	"height" integer,
	"sha256" text,
	"original_key" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_variants" ADD CONSTRAINT "file_variants_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "files_user_created" ON "files" USING btree ("user_id","id" DESC NULLS FIRST) WHERE "files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "files_expires" ON "files" USING btree ("expires_at") WHERE "files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "files_sha" ON "files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "files_activity" ON "files" USING btree ("last_activity_at") WHERE "files"."status" in ('queued', 'processing');--> statement-breakpoint
CREATE INDEX "files_unpurged" ON "files" USING btree ("id") WHERE "files"."status" = 'deleted' and "files"."purged_at" is null;--> statement-breakpoint
CREATE INDEX "session_user_id" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier" ON "verification" USING btree ("identifier");