-- Network events no longer carry an exact time or a new-store flag: their
-- time is cut to the hour by the app, so it matches no row of a per-store
-- table, and which stores are new is now the stores table below.
ALTER TABLE "public"."learned_coupon_box_network_events" DROP COLUMN "new_store",
ALTER COLUMN "created_at" DROP DEFAULT;

UPDATE "public"."learned_coupon_box_network_events"
SET "created_at" = date_trunc('hour', "created_at");

-- CreateTable
CREATE TABLE "public"."learned_coupon_box_stores" (
    "store_domain" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "established_at" TIMESTAMP(3),

    CONSTRAINT "learned_coupon_box_stores_pkey" PRIMARY KEY ("store_domain")
);

-- CreateIndex
CREATE INDEX "learned_coupon_box_stores_established_at_first_seen_at_idx" ON "public"."learned_coupon_box_stores"("established_at", "first_seen_at");

-- Stores that already have boxes count as established: the pool must never
-- push out a store learned before it existed.
INSERT INTO "public"."learned_coupon_box_stores" ("store_domain", "first_seen_at", "established_at")
SELECT "store_domain", min("first_seen_at"), min("first_seen_at")
FROM "public"."learned_coupon_boxes"
GROUP BY "store_domain";
