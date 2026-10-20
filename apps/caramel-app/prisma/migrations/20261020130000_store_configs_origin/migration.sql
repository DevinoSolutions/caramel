-- Who wrote a store_configs row: NULL = the coupons pipeline (every row that
-- exists today), 'auto_detect' = the extension saved a promo box it found and
-- proved on a store with no config (POST /api/extension/coupon-box-save).
--
-- Additive and nullable, so the ALTER is a metadata-only change with no table
-- rewrite and no backfill. A pipeline push for a store whose row is
-- 'auto_detect' replaces all eight selector columns and clears this column
-- (applyCatalogRows), so a pipeline config never mixes with a saved one.

-- AlterTable
ALTER TABLE "public"."store_configs" ADD COLUMN     "origin" TEXT;
