-- Shopper-submitted coupon codes (owner-directed 2026-10-02).
--
-- Signed-in shoppers add codes to the app-owned `coupons` catalog, either
-- captured at checkout by the extension or typed on the store page. Two nullable
-- columns record who and how (both NULL on every supplier row), and a reserved id
-- sequence keeps shopper rows out of the supplier's id space.

-- AlterTable
ALTER TABLE "public"."coupons" ADD COLUMN     "submission_source" TEXT,
ADD COLUMN     "submitted_by_user_id" TEXT;

-- CreateIndex
-- Serves the per-shopper daily-cap count in couponsRepo.submitShopperCoupon.
CREATE INDEX "coupons_submitted_by_user_id_created_at_idx" ON "public"."coupons"("submitted_by_user_id", "created_at");

-- AddForeignKey
-- SET NULL, not CASCADE: deleting an account removes the attribution but leaves
-- the code a store page may already be listing.
ALTER TABLE "public"."coupons" ADD CONSTRAINT "coupons_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateSequence (Prisma's schema language cannot express a sequence, so this is
-- hand-written.) Shopper coupon ids are minted from 900000000000000000 up.
-- src/lib/shopperCoupons.ts SHOPPER_COUPON_ID_FLOOR and the ingest schema's
-- reserved-range refine (src/lib/catalog/ingestSchemas.ts) must keep the SAME
-- floor, so a supplier push can never overwrite a shopper row. MAXVALUE keeps
-- every id within the 18 digits the id contract allows.
CREATE SEQUENCE IF NOT EXISTS "public"."shopper_coupon_id_seq" START WITH 900000000000000000 MINVALUE 900000000000000000 MAXVALUE 999999999999999999;
