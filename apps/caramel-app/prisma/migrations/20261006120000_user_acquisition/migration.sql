-- AlterTable
-- Where the user came from, written ONCE at signup (src/lib/auth/signupCapture.ts):
-- the first-touch cookie record (utm_*, click ids, referrer domain, landing path)
-- plus a derived `source` and the `signup_surface`. Nullable: every user created
-- before this column has no acquisition record, and "unknown" is a real answer,
-- not a default we can invent for them.
ALTER TABLE "public"."users" ADD COLUMN     "acquisition" JSONB;
