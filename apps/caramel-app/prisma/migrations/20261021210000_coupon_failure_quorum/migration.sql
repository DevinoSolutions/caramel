-- Failed-report quorum (T-5535 M3). Additive only.
--
-- coupon_signals.fail_weight: the quorum weight of the failed reports since the
-- last success (sum of the distinct reporters' weights). Defaults to 0, so every
-- existing row reads as "no quorum" until real distinct reporters report it
-- again; fail_count is untouched and no longer decides sink/collapse.
--
-- coupon_signal_reporters: one row per (coupon, outcome, distinct reporter),
-- keyed by a salted hash of the reporter identity (never a raw IP or user id).
-- No foreign key, like coupon_signals.

-- AlterTable
ALTER TABLE "public"."coupon_signals" ADD COLUMN     "fail_weight" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."coupon_signal_reporters" (
    "coupon_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reporter_hash" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "last_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_signal_reporters_pkey" PRIMARY KEY ("coupon_id","outcome","reporter_hash")
);

-- CreateIndex
CREATE INDEX "coupon_signal_reporters_coupon_id_outcome_last_at_idx" ON "public"."coupon_signal_reporters"("coupon_id", "outcome", "last_at");

-- CreateIndex
CREATE INDEX "coupon_signal_reporters_last_at_idx" ON "public"."coupon_signal_reporters"("last_at");
