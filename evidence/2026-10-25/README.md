# Evidence 2026-10-25

- T-7505 PostHog keys: `t7505-posthog-person-delete-keys.png` shows the personal API key list on posthog.devino.ca. Two new keys, person:read+write only: one on project 6 Caramel (mask ...hJqZ), one on project 25 E2E (mask ...PKAb). Values were never printed. The live itest passed 3/3 against project 25.
- #501 (a34a0eb9, PostHog person delete on account deletion): `pr501-checks-headed.png` shows checks green on 12c1f5d. Review MERGE.
- #504 (67bf4ea5, store-search text scrubbed from Sentry + RUNBOOK retention): `pr504-checks-headed.png` shows checks green on 3707956. Review MERGE.
- #506 (8a0af03f, artifact retention ≤3 d, no Playwright traces on green runs, RUNBOOK cutoff): `pr506-checks-headed.png` shows checks green on 9c9a7ab. Review MERGE.
- Prod deploy 697d229, live 06:09:50Z (backup caramel-prod-compose/2026-10-25T05-12-15-314Z.sql.gz first). It carries #497, #498, #499, #501, #502, #504 and #505.
  - `t7505-prod-697d229-home.png` (mid count-up animation), `-home-settled.png` and `-home-dark.png`: Tailwind 4 renders in light and dark (theme vars present, lab() colours).
  - `t7505-prod-697d229-profile-delete-ui.png`: /profile Data & privacy Danger zone with "Delete my data" + "Delete my account" (not clicked). Signed in via Google amin@devino.ca, then signed out.
  - Push E2E 40167442375 rerun green against prod.
  - Sentry: only CARAMEL-2Y/2Z, the iOS 1.6 shell /profile<->/login loop that predates the deploy (T-8305, fix in #503).
- #508 (056e37d8, PostHog recording network URLs scrubbed): `pr508-checks-headed.png` shows checks green. Review MERGE. Prod deploy live 07:30:23Z (backup caramel-prod-compose/2026-10-25T07-17-22-330Z.sql.gz first). Health ok.
  - `pr508-prod-coupons-search-typed.png`: prod /coupons in a headed stealth clone, in a sampled PostHog session (project 6). Marker searches typed: search box `zzscrubthree`, store filter `zzscrubq`.
  - `pr508-prod-recording-payload-scrubbed.png`: the page SENT `?search=zzscrubthree` and `?q=zzscrubq`. The replay payload it POSTed to /_t/k3v/s/ was captured by a pre-load fetch hook (2 gzip batches, 196,240 chars decompressed) and records `search=[Filtered]` and `q=[Filtered]`. The marker appears nowhere in the payload. PostHog ingested that session (01a17201…, 20 keypresses). Both test recordings were then deleted from PostHog. The PostHog UI replay view was not used: this clone only got a password login.
  - Sentry devino/5 after deploy: only CARAMEL-2Y (the known iOS shell loop, T-8305/#503, last seen before the deploy).
- T-7505 recordings (MASTER decision (a), 2026-10-25):
  - `t7505-posthog-p6-recording-retention-30d.png`: project 6 Session replay → Data retention shows **30 days**. The API PATCH returned 500 "Invalid retention entitlement" (the self-hosted org has no SESSION_REPLAY_DATA_RETENTION feature). posthog-selfhost set the value server-side at 07:56Z, logging before=5y, after=30d.
  - Before: 590 recordings, all with retention_period_days=1825 stamped at ingest. 588 started before the scrub cutoff (07:30:23Z): 388 under 30 days, 200 at 30–90 days, none older, oldest 2026-09-16. The other 2 were my own test recordings, already deleted.
  - The 588 were deleted via the app API in 12 batches of 50: 588 × 204. Re-check: 588 × 404 on per-id GET (recording and snapshots). 0 of the 588 had search params in their page-URL metadata. `t7505-posthog-p6-replay-empty-after-delete.png`: the replay list shows no recordings.
