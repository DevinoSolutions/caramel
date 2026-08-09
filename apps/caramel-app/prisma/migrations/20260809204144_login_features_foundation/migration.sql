-- CreateTable
CREATE TABLE "public"."coupon_reports" (
    "id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "user_id" TEXT,
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."favorite_stores" (
    "user_id" TEXT NOT NULL,
    "store_name" TEXT NOT NULL,
    "notify_on_new" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_stores_pkey" PRIMARY KEY ("user_id","store_name")
);

-- CreateTable
CREATE TABLE "public"."savings_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "coupon_id" TEXT,
    "store" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "client_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "savings_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coupon_reports_coupon_id_user_id_created_at_idx" ON "public"."coupon_reports"("coupon_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "savings_events_client_event_id_key" ON "public"."savings_events"("client_event_id");

-- CreateIndex
CREATE INDEX "savings_events_user_id_occurred_at_idx" ON "public"."savings_events"("user_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "public"."coupon_reports" ADD CONSTRAINT "coupon_reports_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."coupon_reports" ADD CONSTRAINT "coupon_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."favorite_stores" ADD CONSTRAINT "favorite_stores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."savings_events" ADD CONSTRAINT "savings_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."savings_events" ADD CONSTRAINT "savings_events_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
