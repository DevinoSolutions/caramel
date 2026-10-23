-- Coupon box proposals (T-6221). Additive only: one new table, no change to an
-- existing one.
--
-- POST /api/extension/coupon-box-save no longer writes store_configs directly.
-- Each signed-in install's save is a row here; the box becomes the store's
-- served config only when enough DISTINCT users proposed the same box
-- (couponBoxSave.recordBoxProposal). The composite primary key is the dedup (one
-- row per user per box). The same rows are the write-budget ledger (per-user,
-- per-store and global daily caps count rows by created_at).

-- CreateTable
CREATE TABLE "public"."coupon_box_proposals" (
    "store_name" TEXT NOT NULL,
    "box_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "apply" TEXT,
    "toggle" TEXT,
    "total" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_box_proposals_pkey" PRIMARY KEY ("store_name","box_hash","user_id")
);

-- CreateIndex
CREATE INDEX "coupon_box_proposals_user_id_created_at_idx" ON "public"."coupon_box_proposals"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "coupon_box_proposals_store_name_created_at_idx" ON "public"."coupon_box_proposals"("store_name", "created_at");

-- CreateIndex
CREATE INDEX "coupon_box_proposals_created_at_idx" ON "public"."coupon_box_proposals"("created_at");

-- AddForeignKey
ALTER TABLE "public"."coupon_box_proposals" ADD CONSTRAINT "coupon_box_proposals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
