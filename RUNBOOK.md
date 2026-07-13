# Caramel — Operations Runbook

Start here at 3am. This is the repo-provided starting point that didn't
exist before F-011 (audit 2026-07-10, `audit/empirical-3am.md` AM-1/AM-9):
where things run, where to look, how to check health, how to roll back, and
the failure signatures worth recognizing on sight.

This file lives at the repo root (not `docs/`) so a cold on-call finds it
with `ls` or a repo search without knowing the doc structure first.

## System map

| Component                                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where it lives                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **caramel-app**                          | Next.js 16 app — marketing site, web app, and the API (`grabcaramel.com`)                                                                                                                                                                                                                                                                                                                                                                                                                               | `apps/caramel-app`, deployed on Dokploy                                                  |
| **caramel-extension**                    | Browser extension (Chrome/Edge/Firefox/Safari) — the client that calls caramel-app's API                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/caramel-extension`, distributed via store review                                   |
| **auth_db** (Postgres)                   | Users, sessions, Better Auth — owned and migrated by this repo (Prisma)                                                                                                                                                                                                                                                                                                                                                                                                                                 | `apps/caramel-app/prisma/schema.prisma`                                                  |
| **coupons_db** (Postgres)                | The entire coupon catalog (`coupons`, `sources`, `verification_stores`, …) — **owned by an external Python verification service**, not this repo. caramel-app only reads it (+3 narrow mutations: usage-increment, expire, inserting a REQUESTED `sources` row) via a raw `postgres` client, never Prisma-migrated here. The Python service must treat those 3 columns/table as co-written — never clobber `times_used`/`last_time_used`, honor `expired`/`expiry` (see DESIGN.md §2 "Write-ownership") | `apps/caramel-app/src/lib/couponsDb.ts` (connection/schemas), `couponsRepo.ts` (queries) |
| **Redis**                                | Provisioned in local-dev infra (`local-dev/docker-compose.yml`) but **not yet wired into application code** — rate limiting today is in-memory (`RateLimiterMemory`), documented as a swap-to-`RateLimiterRedis` TODO for multi-instance scale                                                                                                                                                                                                                                                          | `apps/caramel-app/src/lib/rateLimit.ts`                                                  |
| **Sentry** (self-hosted)                 | Error + APM tracing. `org: devino`, `project: caramel`, instance `https://sentry.devino.ca`. Production-only (`sentry.common.config.ts` — no-ops in dev/test)                                                                                                                                                                                                                                                                                                                                           | `apps/caramel-app/sentry.*.config.ts`, `next.config.mjs`                                 |
| **OpenRouter**                           | LLM hop for the extension's cart classifier (`/api/classify-cart`)                                                                                                                                                                                                                                                                                                                                                                                                                                      | `apps/caramel-app/src/lib/openrouter.ts`                                                 |
| **usesend**                              | Transactional email (`usesend.devino.ca`)                                                                                                                                                                                                                                                                                                                                                                                                                                                               | env: `USESEND_*`                                                                         |
| **External Python verification service** | Scrapes/verifies coupons, owns `coupons_db`. **Not in this repo** — TODO(human): link its repo/runbook here.                                                                                                                                                                                                                                                                                                                                                                                            | n/a                                                                                      |

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
  typecheck / knip / unit / oxlint / schema-drift / e2e),
  `checks-extension.yml` (lint / prettier / unit / size-limit),
  `release-extension.yml` (packages the extension on merge to `main`),
  `coupons-schema-drift.yml` (manual — see below).
- **Uptime monitor**: `src/app/api/health/db/route.ts`'s comments reference
  an external Uptime-Kuma monitor polling this route. TODO(human): record
  its dashboard URL and which monitor entry it is — not present in this
  repo.

## Health checks

`GET /api/health/db` — probes **both** databases this app depends on
(auth_db via Prisma, coupons_db via the raw `postgres` client — F-001).
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
    "auth_db":     { "status": "ok" | "error", "service": "auth_db",     "latencyMs": 5, "details"?: "..." },
    "coupons_db":  { "status": "ok" | "error", "service": "coupons_db",  "latencyMs": 8, "details"?: "..." }
  }
}
```

HTTP status: `200` iff **both** checks are `"ok"`; `503` if **either** is
down; `401` unauthenticated. The monitor's contract (HTTP status code +
top-level `status`) is preserved across the F-001 body-shape change, so an
existing external monitor configured against the old single-DB shape still
alarms correctly.

**If coupons_db reports down:** that's the external Python service's
database — this app has no ability to restart or repair it, only to
observe the outage. Check whether the coupons-facing routes
(`/api/coupons`, `/coupons/[store]`, `/api/extension/supported-stores`, …)
are failing for real users, and escalate to whoever owns that service.

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

Until the TODO above is filled in, the safe manual sequence is:

1. Confirm the outage via `/api/health/db` and Sentry.
2. Open the Dokploy dashboard, find the caramel-app application, and use
   its deployment history to redeploy the last known-good build.
3. Re-run the [post-deploy smoke check](#post-deploy-smoke-check) against
   the rolled-back deployment before declaring it resolved.
4. If the regression was a DB migration, `prisma migrate deploy` is
   forward-only — a bad migration needs a new forward migration or a
   manual DB fix, not a Prisma-level rollback.

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
            "typecheck",
            "knip",
            "oxlint",
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

Run for each of `main` and `dev`. Verify current state first with
`gh api repos/DevinoSolutions/caramel/branches/main/protection` (as of the
audit, this returned `404 Branch not protected`).

## Known failure modes

- **coupons_db schema drift.** `src/lib/couponsDb.ts`'s zod boundary
  throws loudly (`coupons-db schema drift [<query>]: ...`) the instant a
  read call site's expected columns/types don't match what the external
  Python service's DB actually returns, instead of silently serving
  malformed/zeroed data. These throws reach Sentry via `handleRouteError`
  (API routes) or `onRequestError`/`error.tsx` (the SSR store page). The
  proactive half — `pnpm --filter caramel-app check:coupons-schema` —
  runs every query registered in `src/lib/couponsRepo.ts`'s
  `couponsQueryProbes` for real (inside one transaction, always rolled
  back) and catches a rename/drop before a request ever hits it: Postgres
  plans every column/table/predicate before returning rows, so a
  missing/renamed column throws regardless of row count — a run-the-real-
  queries gate, not a hand-maintained column-list mirror (the old
  `scripts/check-coupons-schema.ts` `EXPECTED_COLUMNS` approach, which
  missed JOIN/WHERE columns absent from every zod _output_, e.g. the
  `sources.websites`/`c.site` relationship — deleted). Still **only runs
  via manual `workflow_dispatch`** on
  `.github/workflows/coupons-schema-drift.yml` (a writable private
  coupons DB reachable from GitHub Actions is an infra/security call
  outside this repo's own scope — TODO(human): Aladdin to decide), and
  **that workflow's `COUPONS_DATABASE_URL` repo secret has not been
  added yet** — dispatching it today fails fast with a named error
  pointing at this gap, it does not silently no-op.
- **coupons_db unreachable entirely.** Distinct from drift — the DB itself
  is down/unreachable. Surfaces as `/api/health/db`'s `coupons_db` check
  going `"error"`, and as 500s with `{error: "Error fetching coupons."}`
  (or similar, per-route) from `handleRouteError` on every coupons-facing
  route. Locally this is the **expected, honest state** — no coupons DB is
  provisioned in local dev or CI (see `.github/workflows/*` — no `services:`
  block ever provisions `caramel_coupons`), so `coupons_db` reports down by
  design, not as a bug.
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

## Schema drift check

`.github/workflows/coupons-schema-drift.yml` — manual-only
(`workflow_dispatch`), by design: no coupons DB exists in CI. Run it from
the Actions tab; it fails fast with a named error if the
`COUPONS_DATABASE_URL` repo secret isn't configured (**not yet added as of
this writing**) rather than silently skipping. Locally, `pnpm --filter
caramel-app check:coupons-schema` runs `vitest run --config
vitest.drift.config.ts`, which reads `COUPONS_DATABASE_URL` from
`apps/caramel-app/.env` if present — no env-var prefix needed when that
file already has the real value (it does, by convention — see the root
README's Getting Started). To point it at a DIFFERENT DB one-off (e.g. a
throwaway clone for a red/green proof), override on the command line —
an already-exported shell var wins over `.env`:

```bash
COUPONS_DATABASE_URL=<real-url> pnpm --filter caramel-app check:coupons-schema
```

The gate's red output names the failing query label (e.g. `coupons_db
schema drift [sources.list]: column s.websites does not exist`) — see
`src/lib/couponsRepo.ts`'s `couponsQueryProbes` for the full label list.

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
- **coupons_db** (`src/lib/couponsDb.ts`): a raw SQL connection, not an
  instrumented HTTP call — there is no header channel to carry a trace ID
  across it at all. The `postgres` client now sets
  `connection.application_name: 'caramel-app'`, so queries from this app
  are attributable in `pg_stat_activity` / DB logs instead of appearing
  under the porsager default (`'postgres.js'`) — a per-process signal, not
  a per-request one.
- **Known debt:** full distributed tracing (a shared trace/request ID
  propagated end-to-end across the Next.js ↔ external Python
  coupon-verification service boundary) does not exist. What's here is
  intentionally coarse: it narrows "something's slow/broken" to a process
  and, for OpenRouter, a specific generation — it does not give you a
  single trace ID to paste into two different dashboards.

## Secrets & environment reference

`apps/caramel-app/.env.example` is the tracked source of truth (30 vars,
validated at boot by `src/lib/env.ts` — a misconfigured deploy fails fast
with a named error instead of breaking deep inside a request handler). The
operationally load-bearing ones:

| Var                      | Used for                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | auth_db (Prisma) — required                                                                                   |
| `COUPONS_DATABASE_URL`   | coupons_db (raw `postgres` client) — required                                                                 |
| `COUPONS_ADMIN_SECRET`   | bearer for `POST /api/coupons/expire` + rate-limit trust exemption                                            |
| `UPKUMA_HEALTH_SECRET`   | bearer for `GET /api/health/db`                                                                               |
| `OPENROUTER_API_KEY`     | extension cart classifier (`/api/classify-cart`) — unset throws a named `OpenRouterError`, not a silent no-op |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry init (client + server) — unset means Sentry never initializes, production or not                       |

TODO(human): record where these are actually set/rotated in Dokploy (env
var UI vs. secret store) and the rotation procedure for
`COUPONS_ADMIN_SECRET` / `UPKUMA_HEALTH_SECRET` — not derivable from this
repo.
