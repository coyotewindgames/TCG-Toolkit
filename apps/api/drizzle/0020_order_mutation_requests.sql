CREATE TABLE IF NOT EXISTS "order_mutation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"client_request_id" text NOT NULL,
	"action" text NOT NULL,
	"response_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_mutation_requests_store_client_uq" UNIQUE("store_id","client_request_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_mutation_requests" ADD CONSTRAINT "order_mutation_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_mutation_requests" ADD CONSTRAINT "order_mutation_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_mutation_requests_order_idx" ON "order_mutation_requests" USING btree ("order_id");
