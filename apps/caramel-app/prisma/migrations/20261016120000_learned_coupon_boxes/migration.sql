-- Learned coupon boxes (additive: two new tables, nothing existing changes).
--
-- A coupon box the extension confirmed on a store with no served config, kept
-- so the next shopper on that store can be pointed at it without a model call
-- (src/lib/couponBoxLearned.ts). Selectors and counters only; reporters are kept
-- as salted one-way hashes. Applied by `prisma migrate deploy` at container boot
-- like every migration; no manual step.

-- CreateTable
CREATE TABLE "public"."learned_coupon_boxes" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "input_selector" TEXT NOT NULL,
    "apply_selector" TEXT NOT NULL DEFAULT '',
    "toggle_selector" TEXT NOT NULL DEFAULT '',
    "enter_only" BOOLEAN NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "distinct_installs" INTEGER NOT NULL DEFAULT 0,
    "distinct_networks" INTEGER NOT NULL DEFAULT 0,
    "first_source" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_confirmed_at" TIMESTAMP(3),
    "last_failed_at" TIMESTAMP(3),

    CONSTRAINT "learned_coupon_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."learned_coupon_box_reporters" (
    "id" TEXT NOT NULL,
    "box_id" TEXT NOT NULL,
    "install_hash" TEXT NOT NULL,
    "network_hash" TEXT NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "last_confirmed_at" TIMESTAMP(3),
    "last_failed_at" TIMESTAMP(3),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learned_coupon_box_reporters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "learned_coupon_boxes_domain_input_selector_apply_selector_t_key" ON "public"."learned_coupon_boxes"("domain", "input_selector", "apply_selector", "toggle_selector", "enter_only");

-- CreateIndex
CREATE INDEX "learned_coupon_box_reporters_box_id_last_seen_at_idx" ON "public"."learned_coupon_box_reporters"("box_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "learned_coupon_box_reporters_box_id_install_hash_key" ON "public"."learned_coupon_box_reporters"("box_id", "install_hash");

-- AddForeignKey
ALTER TABLE "public"."learned_coupon_box_reporters" ADD CONSTRAINT "learned_coupon_box_reporters_box_id_fkey" FOREIGN KEY ("box_id") REFERENCES "public"."learned_coupon_boxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
