-- Data + constraint migration: NO column change (prisma migrate diff against
-- the schema stays empty — Prisma does not model CHECK constraints — so the
-- schema-drift job is unaffected).
--
-- `site_suggestions.requester_email` was stored AS TYPED, and the account's
-- delete-my-data scrub and danger-zone count matched it with Prisma's
-- `{ equals, mode: 'insensitive' }`. Prisma compiles that to an UNESCAPED
-- `ILIKE`, so an `_` or `%` in the account's email was a WILDCARD: an account
-- registered as `j_hn@x` counted, and SCRUBBED, the requests `john@x` made
-- while signed out. The match is now EXACT on the folded address
-- (src/lib/siteSuggestionIdentity.ts), and case is settled at write time
-- (recordSiteSuggestion folds). This migration is the one-time catch-up for
-- rows written before that, plus the backstop that keeps it true.
--
-- 1. Fold every earlier address. Idempotent: the WHERE touches only rows that
--    actually differ, so a re-run is a no-op. Nothing else on the row changes;
--    `status_changed_at`/`notified_at` are deliberately left alone, since a
--    fold is not an answer to the request.
UPDATE "public"."site_suggestions"
SET requester_email = lower(requester_email)
WHERE requester_email IS NOT NULL AND requester_email <> lower(requester_email);

-- 2. The database refuses an unfolded address from now on, so a future writer
--    that forgets to fold fails LOUDLY on insert instead of silently storing a
--    spelling the exact match would never find (a request delete-my-data would
--    then leave behind).
ALTER TABLE "public"."site_suggestions"
ADD CONSTRAINT "site_suggestions_requester_email_folded"
CHECK (requester_email IS NULL OR requester_email = lower(requester_email));
