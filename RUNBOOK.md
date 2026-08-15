# Caramel — Operations Runbook

Start here at 3am. This is the repo-provided starting point that didn't
exist before F-011 (audit 2026-07-10, `empirical-3am.md` AM-1/AM-9 in the
maintainers' internal audit archive):
where things run, where to look, how to check health, how to roll back, and
the failure signatures worth recognizing on sight.

This file lives at the repo root (not `docs/`) so a cold on-call finds it
with `ls` or a repo search without knowing the doc structure first.

## System map

| Component                                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Where it lives                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **caramel-app**                          | Next.js 16 app — marketing site, web app, and the API (`grabcaramel.com`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `apps/caramel-app`, deployed on Dokploy                                                                                |
| **caramel-extension**                    | Browser extension (Chrome/Edge/Firefox/Safari) — the client that calls caramel-app's API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `apps/caramel-extension`, distributed via store review                                                                 |
| **auth_db** (Postgres)                   | Users, sessions, Better Auth — owned and migrated by this repo (Prisma)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/caramel-app/prisma/schema.prisma`                                                                                |
| **coupon catalog** (Postgres)            | The published coupon catalog (`coupons`, `store_configs`, `sources`) — **app-owned** since the Coupons Ownership Inversion, in the SAME Postgres as auth_db (`DATABASE_URL`), created by Prisma migrations (`catalog_tables` + a synthetic seed). The external Python pipeline is now a SUPPLIER: it pushes deltas to `POST /api/ingest/catalog` (`applyCatalogRows`, only-if-newer, tombstone-gated). Reads are `prisma.$queryRaw`; sanctioned app writes are `expireCoupons` + `requestSource`; usage telemetry moved to `coupon_signals`. See DESIGN.md §2 "Write-ownership" + docs/INGEST.md | `apps/caramel-app/src/lib/couponsRepo.ts` (queries), `couponsDb.ts` (zod schemas), `src/lib/catalog/*` (ingest/bridge) |
| **Redis**                                | Deliberately **NOT provisioned** — the root `docker-compose.yml` is web + postgres ONLY by design (NF-13). Rate limiting is in-memory single-instance (`RateLimiterMemory`), with a documented swap-to-`RateLimiterRedis` TODO deferred until caramel-app runs multi-instance                                                                                                                                                                                                                                                                                                                    | `apps/caramel-app/src/lib/rateLimit.ts`                                                                                |
| **Sentry** (self-hosted)                 | Error + APM tracing. `org: devino`, `project: caramel`, instance `https://sentry.devino.ca`. Production-only (`sentry.common.config.ts` — no-ops in dev/test)                                                                                                                                                                                                                                                                                                                                                                                                                                    | `apps/caramel-app/sentry.*.config.ts`, `next.config.mjs`                                                               |
| **OpenRouter**                           | LLM hop for the extension's cart classifier (`/api/classify-cart`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `apps/caramel-app/src/lib/openrouter.ts`                                                                               |
| **usesend**                              | Transactional email (`usesend.devino.ca`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | env: `USESEND_*`                                                                                                       |
| **External Python verification service** | Scrapes/verifies coupons; the catalog SUPPLIER. **Not in this repo** — it feeds the app catalog through `POST /api/ingest/catalog` (target state), or during migration is read read-only by the `bridge:sync` job. TODO(human): link its repo/runbook here.                                                                                                                                                                                                                                                                                                                                      | n/a                                                                                                                    |

## Where to look

- **Dokploy** (deploy dashboard, logs, container status, rollback): the
  team's Dokploy instance is `https://devino.basa-ulmer.ts.net/`.
  TODO(human): confirm this is the instance hosting caramel-app, and record
  the exact project/application name within it (this repo has zero tracked
  Dokploy config — `git grep -i dokploy` across the whole tree turns up one
  code comment and nothing else, so the app/project name cannot be derived
  from source).
- **Sentry**: `https://sentry.devino.ca`, org `devino`, project `caramel`.
  Errors from caught route failures (`handleRouteError`, F-002) are tagged
  `route`/`method`/`requestId`; uncaught render errors reach it via
  `error.tsx`/`global-error.tsx` (F-011) and `instrumentation.ts`'s
  `onRequestError`. TODO(human): confirm/record the alert routing (which
  Sentry alert rule pages who, and where — Slack/email/PagerDuty).
- **GitHub Actions**: `.github/workflows/checks-app.yml` (lint / prettier /
  typecheck / knip / unit / oxlint / schema-drift / integration / e2e),
  `checks-extension.yml` (lint / prettier / unit / size-limit),
  `release-extension.yml` (packages the extension on merge to `main`).
- **Uptime monitor**: `src/app/api/health/db/route.ts`'s comments reference
  an external Uptime-Kuma monitor polling this route. TODO(human): record
  its dashboard URL and which monitor entry it is — not present in this
  repo.

## Health checks

`GET /api/health/db` — probes the two data dependencies of this app
(auth_db via Prisma `SELECT 1`, and the app-owned coupon catalog's
non-emptiness + freshness via `prisma.coupon.aggregate` — F-001).
Requires `Authorization: Bearer $UPKUMA_HEALTH_SECRET`; no header (or a
wrong one) is a fail-closed `401` with zero DB calls made.

```bash
curl -s -H "Authorization: Bearer $UPKUMA_HEALTH_SECRET" \
  https://grabcaramel.com/api/health/db
```

Response shape:

```json
{
  "status": "ok" | "error",
  "checks": {
    "auth_db": { "status": "ok" | "error", "service": "auth_db", "latencyMs": 5, "details"?: "..." },
    "catalog": { "status": "ok" | "error", "service": "catalog", "latencyMs": 8, "details": { "count": 1234, "freshestUpdatedAt": "2026-07-14T…", "ageMinutes": 12, "stale": false } }
  }
}
```

The `catalog` check is `ok` iff the aggregate query succeeds AND the catalog is
NON-EMPTY (`count > 0`); its `details` is the structured freshness object above
(or the raw error string on an unexpected throw). `stale` (newest row older
than 48h by default, tunable per deploy via `CATALOG_MAX_AGE_HOURS`) is
observability only — it NEVER flips the check to error.

HTTP status: `200` iff **both** checks are `"ok"`; `503` if **either** is
down; `401` unauthenticated. The monitor's contract (HTTP status code +
top-level `status`) is preserved across the F-001 body-shape change, so an
existing external monitor configured against the old single-DB shape still
alarms correctly.

**If the `catalog` check reports down:** it went `error` because the catalog is
EMPTY (`count === 0`) or the query threw (DB/table unreachable) — NOT for
staleness (a stale-but-non-empty catalog stays `ok`, surfacing `stale: true`).
An empty catalog usually means migrations/seed never ran, or (in prod) the
supplier feed hasn't populated it: confirm `prisma migrate deploy` ran, and that
the pipeline is pushing to `POST /api/ingest/catalog` or the `bridge:sync` job is
running (see "Coupons ingest & bridge sync" below and docs/INGEST.md).

**If auth_db reports down:** login/signup/session-dependent routes are
broken. Check Dokploy's Postgres container/managed DB status first.

## Deploys & rollback

Deploys run through Dokploy. TODO(human): record the exact deploy trigger
(push to `main`? manual redeploy button?) and the precise rollback
procedure (Dokploy has a rollback-to-previous-deployment action in its UI —
confirm the button location for this specific application) — this repo
carries a DB-migration step (`prisma migrate deploy`, see
`package.json`'s `db:migrate:deploy`) but **no app-deploy workflow, and no
rollback automation or documentation existed anywhere in the tracked files
before this doc** (confirmed: `git grep -i dokploy` across the repo,
excluding `audit/`, returns a single code comment).

Since F-016 the root `docker-compose.yml` (`Dockerfile` +
`docker-entrypoint.sh`) is the INTENDED deployment unit — local and CI build
and run this exact graph, and prod is meant to run the same file as one
platform compose service. The prod cutover onto it is still gated and
human-run (never move prod traffic without explicit in-session confirmation);
until it lands, prod stays on the current Dokploy/Nixpacks deploy.

Until the TODO above is filled in, the safe manual sequence is:

1. Confirm the outage via `/api/health/db` and Sentry.
2. Open the Dokploy dashboard, find the caramel-app application, and use
   its deployment history to redeploy the last known-good build.
3. Re-run the [post-deploy smoke check](#post-deploy-smoke-check) against
   the rolled-back deployment before declaring it resolved.
4. If the regression was a DB migration, `prisma migrate deploy` is
   forward-only — a bad migration needs a new forward migration or a
   manual DB fix, not a Prisma-level rollback.

**Compose-mode migration failure (once prod runs the root compose).** The
container applies `prisma migrate deploy` fail-hard at boot
(`docker-entrypoint.sh`, `set -e`, no `|| true`), so a bad migration is a
VISIBLE crash-loop, not a silent bad serve: `restart: unless-stopped` keeps
restarting the `web` service, and `docker compose logs web` shows the
entrypoint markers (`>>> [entrypoint] applying prisma migrate deploy` with no
following `migrations applied` line) pinpointing the failing migration. The
fix is the SAME forward-only rule: revert the offending migration commit and
redeploy — never hand-edit the production database.

### Branch protection (handoff, not yet applied)

Repo settings are not something an agent mutates. The exact commands,
carried from F-009's plan and the audit PR body, for a human to run once
this audit branch merges to real `main`/`dev`:

```bash
gh api -X PUT repos/DevinoSolutions/caramel/branches/<branch>/protection --input protection.json
```

where `protection.json` is:

```json
{
    "required_status_checks": {
        "strict": true,
        "contexts": [
            "lint",
            "prettier",
            "prettier-root",
            "typecheck",
            "knip",
            "unit",
            "oxlint",
            "Integration (DB)",
            "Schema Drift",
            "checks",
            "E2E & Visual Regression (PR)"
        ]
    },
    "enforce_admins": true,
    "required_pull_request_reviews": { "required_approving_review_count": 1 },
    "restrictions": null
}
```

Deliberately NOT listed: `One-root-compose build` (`compose-build`) — it is
path-filtered (runs only when compose/docker files change), and a required
context that doesn't run blocks every unrelated PR.

Run for each of `main` and `dev`. Verify current state first with
`gh api repos/DevinoSolutions/caramel/branches/main/protection` (as of the
audit, this returned `404 Branch not protected`).

## Known failure modes

- **Catalog schema drift.** `src/lib/couponsDb.ts`'s zod boundary throws
  loudly (`coupons-db schema drift [<query>]: ...`) the instant a read call
  site's expected columns/types don't match what the app catalog returns,
  instead of silently serving malformed/zeroed data. These throws reach
  Sentry via `handleRouteError` (API routes) or `onRequestError`/`error.tsx`
  (the SSR store page). The proactive half is now the **integration suite**
  (`pnpm --filter caramel-app test:integration` — `coupons-read.itest.ts`,
  `coupons-write.itest.ts`, `ingest-catalog.itest.ts`, `bridge-sync.itest.ts`)
  running the real queries against a live app Postgres in CI; it REPLACED the
  deleted structural drift gate (`check:coupons-schema` / `EXPECTED_COLUMNS` /
  `couponsQueryProbes`, removed in W4).
- **Ingest push refused (tombstone gate).** `POST /api/ingest/catalog` returns
  `409 {error, gate}` (and the `bridge:sync` job logs `REFUSED` + exits
  non-zero, writing NOTHING) when a single push would expire/tombstone >20% of
  the currently-visible catalog. This is the wholesale-wipe guard, not a bug: a
  broken producer cannot nuke the catalog with one bad push. A human confirms
  the mass-expiry is legitimate, then re-runs with `force` (see "Coupons ingest
  & bridge sync" below). Any OTHER error out of `applyCatalogRows` (bad data
  mid-batch, DB loss) rolls the whole transaction back and reaches Sentry via
  `handleRouteError` — never a partial write.
- **Catalog empty / unreachable.** `/api/health/db`'s `catalog` check goes
  `"error"` when the catalog is EMPTY (`count === 0`) or the aggregate query
  throws (DB/table unreachable), returning `503`. NOT for staleness — a
  stale-but-non-empty catalog stays `ok` with `stale: true`. An empty catalog in
  prod means the pipeline/bridge has not populated it; locally it means `prisma
migrate deploy` (which also seeds) has not run.
- **Caught route errors used to vanish.** Before F-002, every
  `catch (error) { ... return 500 }` site swallowed the error — only
  truly uncaught errors reached Sentry. `handleRouteError`
  (`src/lib/api/handleRouteError.ts`) closes that gap: every caught route
  error now reports to Sentry (tagged `route`/`method`/`requestId`) and
  returns a distinguishable `{error}` body + `x-request-id` response
  header. If you're grepping logs for a specific failed request, match on
  that header's value against the Sentry `requestId` tag.
- **Uncaught render errors used to show Next's generic error page.**
  F-011 adds `apps/caramel-app/src/app/error.tsx` (route-segment boundary,
  renders inside the root layout, reports to Sentry) and `global-error.tsx`
  (last-resort — fires only when the ROOT layout itself throws; replaces
  the entire document, so it's deliberately dependency-free: no Providers,
  no data fetching, inline styles only). Both report via
  `Sentry.captureException` in a `useEffect`.
- **`COUPONS_ADMIN_SECRET` unset or wrong.** Gates both `POST
/api/coupons/expire` and the rate-limit trust exemption
  (`isTrustedServer` in `src/lib/rateLimit.ts`). Unset → fail-closed (every
  caller treated as untrusted/unauthorized, never fail-open). **This
  secret must be set in Dokploy for caramel-app's production/staging
  environment** — it replaces the old `EXTENSION_API_KEY`, which is
  retired (F-003) and no longer shipped to or accepted from the extension.
- **`UPKUMA_HEALTH_SECRET` unset.** `/api/health/db` fail-closes to `401`
  even with a bearer header sent — this is intentional (see
  `tests/unit/health-db.test.ts`), not a bug, but it means the external
  uptime monitor silently can't authenticate if this secret drifts between
  the monitor's config and Dokploy's env.
- **Rate limiting is in-memory, per-instance.** `src/lib/rateLimit.ts`
  fails open if the limiter itself throws (never blocks legit traffic on
  an internal bug), but its budgets reset per process — if caramel-app
  ever runs as more than one instance, abuse limits are effectively
  multiplied by instance count until the documented `RateLimiterRedis`
  swap happens.

## Coupons ingest & bridge sync

The app owns the coupon catalog; the external Python pipeline SUPPLIES it. Two
feed paths share ONE engine (`applyCatalogRows` — a pure only-if-newer delta
upsert in a single transaction, guarded by the >20% tombstone gate). Full
contract: `docs/INGEST.md`.

- **Direct push (target state):** the pipeline `POST`s catalog deltas to
  `/api/ingest/catalog`, bearer-authed with `INGEST_API_KEY`. `200 {ok, applied}`
  on success; `409 {error, gate}` if the tombstone gate refused it (nothing
  written); `422` on an empty/invalid payload; `401` without the bearer.
- **Bridge sync (migration-period feed):** until the pipeline pushes directly,
  `pnpm --filter caramel-app bridge:sync` (needs `COUPONS_DATABASE_URL`, the
  read-only external connection string) reads the still-live external
  `caramel_coupons` Postgres (SELECT-only) and replays it through the same
  engine. It logs `OK` with per-entity counts, or `REFUSED`/`FAILED` and exits
  non-zero — never a silent no-op.

```bash
COUPONS_DATABASE_URL=<read-only-external-url> pnpm --filter caramel-app bridge:sync
```

**Tombstone-gate refusal (how to proceed).** A `409` (push) or `REFUSED`
(bridge) means the feed would expire >20% of the currently-visible catalog and
was rolled back untouched — the wholesale-wipe guard. A human verifies the
mass-expiry is legitimate (e.g. a genuine large delisting), then re-runs with
`force`: the push resends the same body with `"force": true`; the bridge needs
`runBridge(sql, { force: true })` (a `--force` CLI flag is a documented TODO in
`scripts/bridge-sync.ts`, to be wired by a human the first time it's needed).

**Catalog freshness.** Check it any time via `GET /api/health/db` — the
`catalog` check's `details` carries `{count, freshestUpdatedAt, ageMinutes,
stale}`. `stale: true` (newest row older than 48h by default, tunable per
deploy via `CATALOG_MAX_AGE_HOURS`) is observability only; it never fails the
check. Only an empty or unreachable catalog is a `503`.

## Post-deploy smoke check

`apps/caramel-app/scripts/smoke.ts` — hits `/` (expects `200` + HTML),
`/api/health/db` (expects `200` + every reported check `status: "ok"`),
and `/api/coupons?site=amazon.com` (expects `200` + a `coupons` array).
Prints `PASS`/`FAIL` per check and exits non-zero on the first failure.

```bash
BASE_URL=https://grabcaramel.com UPKUMA_HEALTH_SECRET=*** \
  pnpm --filter caramel-app run smoke
```

`BASE_URL` defaults to `http://localhost:58000` (the local dev port) if
unset. **Not wired into the Dokploy deploy pipeline** — this is a callable
command a human (or a future CI/CD step) runs after a deploy, not an
automatic gate. TODO(human): wire this into the actual Dokploy post-deploy
hook once the deploy trigger itself (see "Deploys & rollback" above) is
documented.

## Cross-hop trace correlation (coarse — known debt)

Sentry APM tracing (`tracesSampleRate: 1`, production-only) covers
in-process spans automatically, including outbound `fetch` calls
(`nativeNodeFetchIntegration`, on by default). Two real hops need more
than that:

- **OpenRouter** (`src/lib/openrouter.ts`): Sentry auto-spans the fetch,
  but OpenRouter doesn't participate in that trace. The `chat()` helper
  attaches an `X-Request-Id` header (a request id we generate — OpenRouter
  ignores it, but it's usable if outgoing requests are ever logged) and,
  on success, stashes both that id and OpenRouter's own response `id`
  (the generation id visible in OpenRouter's dashboard) as attributes on
  whatever Sentry span is active. This is annotation, not a new span —
  it's a no-op outside production (`Sentry.getActiveSpan()` is always
  `undefined` when Sentry isn't initialized).
- **coupon catalog** (`src/lib/couponsRepo.ts`): app reads are
  `prisma.$queryRaw` against `DATABASE_URL` (the same Prisma pool as auth_db),
  a raw SQL path with no header channel to carry a trace ID. The porsager
  `postgres` client now survives ONLY in `scripts/bridge-sync.ts`, which tags
  its read-only external connection `application_name: 'caramel-bridge-sync'`
  in `pg_stat_activity` — a per-process signal, not a per-request one.
- **Known debt:** full distributed tracing (a shared trace/request ID
  propagated end-to-end across the Next.js ↔ external Python
  coupon-verification service boundary) does not exist. What's here is
  intentionally coarse: it narrows "something's slow/broken" to a process
  and, for OpenRouter, a specific generation — it does not give you a
  single trace ID to paste into two different dashboards.

## Secrets & environment reference

`apps/caramel-app/.env.example` is the tracked source of truth
(validated at boot by `src/lib/env.ts` — a misconfigured deploy fails fast
with a named error instead of breaking deep inside a request handler). The
operationally load-bearing ones:

| Var                      | Used for                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | auth_db + the app-owned coupon catalog (Prisma) — required                                                    |
| `COUPONS_DATABASE_URL`   | OPTIONAL, bridge-sync only — read-only external `caramel_coupons` connection string; unset in normal deploys  |
| `INGEST_API_KEY`         | bearer for `POST /api/ingest/catalog` (the coupons pipeline supplier push) — server-to-server, never a client |
| `COUPONS_ADMIN_SECRET`   | bearer for `POST /api/coupons/expire` + rate-limit trust exemption                                            |
| `UPKUMA_HEALTH_SECRET`   | bearer for `GET /api/health/db`                                                                               |
| `OPENROUTER_API_KEY`     | extension cart classifier (`/api/classify-cart`) — unset throws a named `OpenRouterError`, not a silent no-op |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry init (client + server) — unset means Sentry never initializes, production or not                       |

TODO(human): record where these are actually set/rotated in Dokploy (env
var UI vs. secret store) and the rotation procedure for
`COUPONS_ADMIN_SECRET` / `UPKUMA_HEALTH_SECRET` — not derivable from this
repo.
