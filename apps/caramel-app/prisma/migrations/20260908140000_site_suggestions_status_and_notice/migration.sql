-- AlterTable
ALTER TABLE "public"."site_suggestions" ADD COLUMN     "notified_at" TIMESTAMP(3),
ADD COLUMN     "status_changed_at" TIMESTAMP(3);
