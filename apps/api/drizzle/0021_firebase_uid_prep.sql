-- Additive Firebase Authentication preparation.
-- Nullable by design until every existing account has been imported and
-- reconciled. PostgreSQL unique indexes allow multiple NULL values.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "firebase_uid" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_firebase_uid_uq"
  ON "users" USING btree ("firebase_uid");