-- Grandfather codes already sunk/collapsed under the old raw-count rule
-- (T-5535 M3). Data only, no schema change; runs once.
--
-- Before the quorum, a code sank at 2 recent failures and collapsed at 3. Prod
-- on 2026-10-21 had 203 sunk codes (84 of them collapsed); letting all of them
-- reappear at once would be shopper harm, and most are real dead codes. Each
-- gets ONE synthetic reporter row, reporter_hash 'legacy' (not a real hash, so
-- no personal data), weight LEAST(fail_count, 3) * 2 (= 4 sinks, 6 collapses:
-- exactly the old thresholds), last_at = its last failure. The quorum
-- bookkeeping then needs no special case: the row counts only while last_at is
-- inside the 30-day window and newer than the last success, so it ages out on
-- its own, a later success clears it, and the retention sweep deletes it.
-- New reports add real reporters on top. fail_weight is seeded to match, because
-- the SQL ordering reads it before any new report recomputes it.

INSERT INTO "public"."coupon_signal_reporters" ("coupon_id", "outcome", "reporter_hash", "weight", "last_at")
SELECT "coupon_id", 'failed', 'legacy', LEAST("fail_count", 3) * 2, "last_failed_at"
FROM "public"."coupon_signals"
WHERE "fail_count" >= 2
  AND "last_failed_at" > (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days'
  AND ("last_worked_at" IS NULL OR "last_failed_at" > "last_worked_at")
ON CONFLICT DO NOTHING;

UPDATE "public"."coupon_signals"
SET "fail_weight" = LEAST("fail_count", 3) * 2
WHERE "fail_count" >= 2
  AND "last_failed_at" > (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days'
  AND ("last_worked_at" IS NULL OR "last_failed_at" > "last_worked_at");
