-- "New customers only" label on coupons (owner decision 2026-10-19, T-2956).
--
-- Additive and nullable: NULL means no producer has said (read as false), so the
-- ALTER is a metadata-only change with no table rewrite and no backfill. Ingest
-- keeps the stored value when a push omits it (applyCatalogRows' COALESCE).

-- AlterTable
ALTER TABLE "public"."coupons" ADD COLUMN     "new_customers_only" BOOLEAN;
