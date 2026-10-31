ALTER TABLE "files" DROP CONSTRAINT "files_api_key_id_api_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;