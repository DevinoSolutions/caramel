-- CreateTable
CREATE TABLE "public"."learned_coupon_box_network_events" (
    "id" TEXT NOT NULL,
    "network_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "new_store" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learned_coupon_box_network_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learned_coupon_box_network_events_network_hash_kind_created_idx" ON "public"."learned_coupon_box_network_events"("network_hash", "kind", "created_at");

-- CreateIndex
CREATE INDEX "learned_coupon_box_network_events_created_at_idx" ON "public"."learned_coupon_box_network_events"("created_at");

