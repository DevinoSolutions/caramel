-- Additive only: one index, no column or data change (T-6222 review).
--
-- The checkout worked-stamp policy (checkoutWorkedStamp.ts) counts a shopper's
-- recent coupon_reports rows of one outcome inside a transaction, per submit.
-- The existing (coupon_id, user_id, created_at) index leads with coupon_id and
-- cannot serve that, so the count would scan the table.

-- CreateIndex
CREATE INDEX "coupon_reports_user_id_outcome_created_at_idx" ON "public"."coupon_reports"("user_id", "outcome", "created_at");
