-- AlterTable
-- Opt-in cloud savings sync. NOT NULL DEFAULT false so every existing row is
-- backfilled to "has not consented" — the only safe reading of silence.
ALTER TABLE "public"."users" ADD COLUMN     "savings_sync_enabled" BOOLEAN NOT NULL DEFAULT false;
