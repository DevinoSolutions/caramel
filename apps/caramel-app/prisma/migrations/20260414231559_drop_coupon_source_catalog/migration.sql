-- Coupon catalog ownership moved to the Python verification service,
-- which manages these tables in the separate `caramel_coupons` database
-- via SQLModel + Alembic. Next.js now reads the catalog over a direct
-- postgres client (see src/lib/couponsDb.ts).

-- Drop FK before dropping tables
ALTER TABLE IF EXISTS "Coupon" DROP CONSTRAINT IF EXISTS "Coupon_sourceId_fkey";

DROP TABLE IF EXISTS "Coupon";
DROP TABLE IF EXISTS "Source";

DROP TYPE IF EXISTS "DiscountType";
DROP TYPE IF EXISTS "SourceStatus";

-- pg_trgm was only used for Coupon trigram search; no other model uses it
DROP EXTENSION IF EXISTS "pg_trgm";
