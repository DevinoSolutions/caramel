-- T-6225: close the check-then-insert race in requestSource by adding a
-- unique constraint on sources.source. Concurrent identical POSTs can no
-- longer both insert; the Prisma create will throw P2002 (handled as
-- 'duplicate' in the route).
--
-- Dedup first: keep the oldest row per source value, delete the rest.
DELETE FROM sources a
USING sources b
WHERE a.source = b.source
  AND a.created_at > b.created_at;

-- CreateIndex
CREATE UNIQUE INDEX "sources_source_key" ON "sources"("source");
