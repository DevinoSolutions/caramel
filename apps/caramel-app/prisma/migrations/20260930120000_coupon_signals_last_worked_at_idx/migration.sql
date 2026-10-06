-- Index for the landing page's "Codes that just worked" read
-- (couponsRepo.listRecentlyWorkedCoupons): a range scan over the last day of
-- successful applies, newest first, instead of a full coupon_signals scan.
-- Read-path only — no data change.
-- CreateIndex
CREATE INDEX "coupon_signals_last_worked_at_idx" ON "public"."coupon_signals"("last_worked_at" DESC);
