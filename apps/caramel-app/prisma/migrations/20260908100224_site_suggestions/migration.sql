-- CreateTable
CREATE TABLE "public"."site_suggestions" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "raw_url" TEXT NOT NULL,
    "user_id" TEXT,
    "requester_email" TEXT,
    "source" TEXT NOT NULL,
    "user_agent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "imported_at" TIMESTAMP(3),

    CONSTRAINT "site_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_suggestions_status_created_at_idx" ON "public"."site_suggestions"("status", "created_at");

-- CreateIndex
CREATE INDEX "site_suggestions_domain_idx" ON "public"."site_suggestions"("domain");

-- AddForeignKey
ALTER TABLE "public"."site_suggestions" ADD CONSTRAINT "site_suggestions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
