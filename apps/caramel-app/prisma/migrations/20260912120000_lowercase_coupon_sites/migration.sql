-- Data-only migration: NO schema change (prisma migrate diff against the
-- schema stays empty, so the schema-drift job is unaffected).
--
-- Domains are case-insensitive, but `coupons.site` was stored verbatim from
-- the producer and the store-page reads match `site = $base OR site LIKE
-- '%.' || $base` case-SENSITIVELY on a lowercased $base (resolveStoreDomain
-- lowercases). Measured on prod 2026-09-11: 2 sites carried uppercase
-- (`Brooklinen.com`, `eNasco.com`) — the eNasco rows were unreachable from
-- ANY store page (/coupons/enasco.com and /coupons/eNasco.com both rendered
-- the empty state with noindex) while the sitemap listed eNasco.com anyway.
--
-- From this migration on, applyCatalogRows lowercases `site` on every write,
-- so this backfill is the one-time catch-up. Idempotent: the WHERE touches
-- only rows that actually differ, so a re-run is a no-op. `updated_at` is
-- deliberately NOT bumped — the ingest only-if-newer rule keys on it, and a
-- bump would freeze these rows against the producer's next push.
UPDATE "public"."coupons"
SET site = lower(site)
WHERE site IS NOT NULL AND site <> lower(site);
