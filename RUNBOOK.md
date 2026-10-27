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
| **Sendly**                               | Transactional email (`api.sendly.now`, `sendly-sdk`; the only email transport, useSend/Resend retired)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | env: `SENDLY_*`; `apps/caramel-app/src/lib/email.ts`                                                                   |
| **External Python verification service** | Scrapes/verifies coupons; the catalog SUPPLIER. **Not in this repo** — it feeds the app catalog through `POST /api/ingest/catalog` (target state), or during migration is read read-only by the `bridge:sync` job. TODO(human): link its repo/runbook here.                                                                                                                                                                                                                                                                                                                                      | n/a                                                                                                                    |

## Where to look

- **Dokploy** (deploy dashboard, logs, container status, rollback): the
  team's internal Dokploy instance (reachable only on the team network).
  Prod is the "Caramel Prod Compose (LIVE)" compose service in the Caramel
  project; see [Deploys & rollback](#deploys--rollback) for how it deploys.
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

## Edge cache (Cloudflare)

Cloudflare sits in front of Traefik and, by default, only caches static
file extensions — `s-maxage` on an API JSON response is ignored
(`cf-cache-status: DYNAMIC`). A zone **Cache Rule** ("Cache
/api/extension/supported-stores and /api/coupons per origin
Cache-Control", phase `http_request_cache_settings`, created 2026-09-04)
makes those two paths cache-eligible with edge TTL = respect origin, so
the route's `s-maxage=300` / `s-maxage=60` actually applies. Verify with
`curl -sI https://grabcaramel.com/api/extension/supported-stores | grep
cf-cache-status` — the second hit must say `HIT`. `/api/extension/
supported-stores` additionally keeps a 5-min in-process cache of its
serialized 1.2 MB body (`src/lib/supportedStoresCache.ts`, invalidated by
an ingest push that upserts store_configs), so origin stays cheap even
when the edge misses.

**Capability-gated stores.** `/api/extension/supported-stores` answers
`{ supported, gated }`. A store listed in `src/lib/extensionCapabilityGates.ts`
(porkbun.com today) is served ONLY in `gated`, tagged with the capability it
`requires`, so extension builds that predate the bucket cannot auto-apply on it
(a per-request version/header gate would be ignored or poisoned by the edge
cache above). No extension build reads `gated` yet (TODO 2026-10-16, see
`supportedStoresCache.ts`): the reader belongs in `store-detect.js`, which is
held back while other work owns that file. The supplier row is unchanged;
gating is a read-side rule, not a catalog write.

**Gated stores on `GET /api/coupons`.** Installed 1.4.13/1.4.14 have a generic promo-box
finder that needs no store config, so on porkbun.com they fetch codes by domain
from `/api/coupons` and drive the checkout. That endpoint therefore withholds a
gated store's codes (`coupons: []`, `total: 0`, header
`X-Caramel-Capability-Withheld: alertShim`) from a request that carries an
extension Origin (`chrome-/moz-/safari-web-extension://`) and no `?caps=<capability>`
proof; builds that ship `extension-capabilities.js` send `caps=alertShim` only
while the page marker is stamped. Requests without an extension Origin (the
website, curl) still get the full list. Gated-site responses are
`Cache-Control: private, no-store` because the Cloudflare rule keys on the URL,
not the Origin. Nothing lifts the withhold except a build that proves the
capability; removing the store from `EXTENSION_CAPABILITY_GATES` lifts it for
everyone. The Origin half of the check is a stopgap for builds before 1.4.15
(see the dated TODO in `extensionCapabilityGates.ts`). The browser may also hold
a pre-deploy copy of the full list (`max-age=14400` on the old response) for up
to 4 h; nothing server-side can reach it. Verify on prod:

```
curl -s 'https://grabcaramel.com/api/coupons?site=porkbun.com&limit=3'   # website view: coupons present
curl -s -H 'Origin: chrome-extension://x' 'https://grabcaramel.com/api/coupons?site=porkbun.com&limit=3'                 # old build: coupons [] + total 0
curl -s -H 'Origin: chrome-extension://x' 'https://grabcaramel.com/api/coupons?site=porkbun.com&limit=3&caps=alertShim'  # new build: coupons present
```

## Health checks

`GET /api/health` — container **liveness** (`src/app/api/health/route.ts`),
the target of the compose `web` healthcheck. No DB, no rate limit, no auth,
`Cache-Control: no-store`; answers `{"status":"ok"}` whenever the Node
process accepts requests. It decides ROUTING (Traefik's docker provider
stops routing to an `unhealthy` container → users get 404), so it must
only fail when the process is dead or wedged — never because a request
elsewhere is slow. The Aug 13 - Sep 4 2026 "Caramel is offline" streak was
exactly that: the probe used to hit the homepage with a 5s timeout and
flipped the container unhealthy whenever the app was merely slow.
Do not point the healthcheck back at `/` or at `/api/health/db`.

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

Deploys run through Dokploy. Prod (grabcaramel.com, www and docs) is the
**"Caramel Prod Compose (LIVE)"** compose service in the Caramel Dokploy
project. It builds the root `docker-compose.yml` from `main`.

**Prod deploys are manual by design: auto-deploy is OFF on the prod
compose.** A push to `main` still reaches Dokploy through the GitHub App
webhook, and Dokploy answers `200 {"message":"No apps to deploy"}`. Merging to
`main` therefore never deploys by itself. Verified on 2026-10-27: #569 and #571
sat undeployed until a deploy was queued by hand.

Merge-to-main checklist (whoever merges does all of it):

1. Right after the merge, take a backup of the prod compose's Postgres (the
   compose backup in Dokploy), then queue ONE prod deploy of the compose.
   Never queue in the 23:55-00:05Z window (a team-wide no-deploy rule for
   the shared Dokploy host around 00:00Z). Keep at most one queued deploy per
   service: if one is already waiting, leave it alone (it builds `main`'s HEAD
   when it runs) and never re-queue.
2. When the deploy is done, check that `https://grabcaramel.com/api/version`
   reports the merged sha (or a descendant) and capture it.
3. Re-run the failed E2E job of the newest merge commit on `main` that the
   deploy carries, once. Never re-run several at once: a re-run in the same
   concurrency group cancels any other in-flight one. On `main` the push-mode
   E2E job checks once that prod already serves the commit or a descendant of
   it (`DEPLOY_WAIT_TIMEOUT_SECONDS` is `0` there; ancestry is decided by
   GitHub's compare API) and fails immediately when it does not, which is
   every merge, because no deploy has run yet. Re-run it after step 2 passes.
   One deploy usually carries several merges: older merge commits' E2E runs
   stay red on the commit list by design (they would pass on a re-run, since
   prod serves a descendant of them, but the newest one is enough).

Since F-016 the root `docker-compose.yml` (`Dockerfile` +
`docker-entrypoint.sh`) is the INTENDED deployment unit — local and CI build
and run this exact graph, and prod runs the same file as one platform
compose service. The prod cutover onto it was gated and human-run, and it
happened on 2026-08-08 (moving prod traffic still needs explicit in-session
confirmation).

Rollback sequence:

1. Confirm the outage via `/api/health/db` and Sentry.
2. Open the Dokploy dashboard, find the prod compose (above), and use its
   deployment history to redeploy the last known-good build. TODO(human):
   confirm the exact rollback button for the compose service.
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
- **Apple sign-in fails / boot dies naming `APPLE_*`.** (2026-10-03) The old
  static `APPLE_CLIENT_SECRET` env value was a pre-signed JWT that expired
  2026-09-27 (Apple caps them at ~6 months); Apple sign-in was broken on prod +
  dev from then until this change. The app now signs its own secret at runtime
  (`src/lib/auth/appleClientSecret.ts`) from `APPLE_TEAM_ID`, `APPLE_KEY_ID`
  and `APPLE_PRIVATE_KEY` (the `.p8` file; it lives ONLY in the Dokploy env).
  When `APPLE_CLIENT_ID` is set all three are required — boot fails fast naming
  the missing one, and a malformed key fails boot too (`instrumentation.ts`
  signs once). **Deploy order: set the three vars in Dokploy BEFORE deploying.**
  Dokploy stores env values unquoted on ONE line, so paste the PEM with literal
  `\n` between lines (real newlines also work). Nothing to rotate on a schedule:
  the JWT is re-minted automatically (180-day tokens, re-signed when under 30
  days remain) on BOTH the web sign-in path (better-auth reads the config's
  `clientSecret` getter at every token exchange) and the extension route, with
  no redeploy or restart needed; only rotate if the `.p8` key itself is
  revoked in the Apple developer portal (then update `APPLE_KEY_ID` +
  `APPLE_PRIVATE_KEY` together and redeploy).
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

`BASE_URL` defaults to `http://localhost:28000` (the local dev port) if
unset. **Not wired into the Dokploy deploy pipeline** — this is a callable
command a human (or a future CI/CD step) runs after a deploy, not an
automatic gate. TODO(human): wire this into the actual Dokploy post-deploy
hook once the deploy trigger itself (see "Deploys & rollback" above) is
documented.

## Android app (`apps/caramel-android`, com.devino.caramel)

Native shell: grabcaramel.com in a WebView plus a native Google/Apple sign-in sheet. The workflow
is `.github/workflows/release-android-app.yml` (PRs: debug build, unit tests, lint, unsigned
release + `lintVitalRelease`; `android-v*` tags: signed AAB to the Play internal track). The
owner pushes the tags; agents never do.

**Gate: android-v\* tag requires: shrunk release smoke + signed-in/deletion walk on a Play image.**
The walk is done on the SHRUNK build (R8 + resource shrinking, which is where a signed-in
regression such as a stripped serializer shows up), signed in, through account deletion, on an
emulator image that has Play services. Because the app signs in with Google or Apple only, the
signed-in part uses the dev-only proof path below.

## Dev-only proof path (social-only sign-in apps)

**What it is.** A social-only app cannot be walked signed in without a real Google/Apple account,
and no new external accounts are allowed. So `dev.grabcaramel.com` can mint a session for a
throwaway `devproof+<slug>@devino.ca` user, and a dev-only Android build type accepts it. It is
for proof walks only; it is never shipped and never exists in production. This is the pattern
other apps in the fleet should copy.

**The two server gates** (`src/lib/devProof.ts`, `src/app/api/dev-proof/session/route.ts`):

1. `DEV_PROOF_SESSION_SECRET` (zod `min(32)`, optional) is set ONLY in the DEV deployment's env.
   Unset, which is every production and default deploy, `POST /api/dev-proof/session` answers a
   bare 404 (no body), as for a route that does not exist. (A route handler's 404 has no body;
   an unknown path renders Next's not-found page, so the two differ in body, not status.)
2. Even with the secret set, the route answers the same 404 when ANY of the Host header,
   `X-Forwarded-Host`, the request URL, `BETTER_AUTH_URL` or the baked `NEXT_PUBLIC_BASE_URL`
   names a production host. The check is a denylist: every `*.grabcaramel.com` name (apex, `www`,
   `docs`, anything new) except `dev.grabcaramel.com` is production; an unparseable value counts
   as production. Localhost, the compose service name and the emulator's `10.0.2.2` pass.

And it cannot be pointed at a real person: the body may only name an address matching
`^devproof\+[a-z0-9-]{1,40}@devino\.ca$`. Auth is `Authorization: Bearer <secret>`, compared with
`timingSafeEqual` over SHA-256 digests. Each client IP gets 10 calls an hour, refused ones
included. Every call that gets past the 404 gate leaves an audit record (log line `[dev-proof]
{...}`, a Sentry breadcrumb and an info-level Sentry message): outcome, the test email (only if it
matched the pattern) and a keyed hash (HMAC with the secret) of the requester IP; never the secret or the token. The route
creates the user the way a Google sign-in does (`mintExtensionSession`, a synthetic `google`
account `devproof:<email>`, `emailVerified`), so a second call for the same address reuses the
user and mints a fresh 7-day session.

**Mint a session** (secret from the DEV compose env; do not echo it into logs or tickets):

```bash
curl -sS -X POST https://dev.grabcaramel.com/api/dev-proof/session \
  -H "Authorization: Bearer $DEV_PROOF_SESSION_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"email":"devproof+walk-1@devino.ca"}'
# 200 {"token":"<43-char bearer>","expiresAt":"2026-11-03T12:00:00.000Z"}
```

`404` = not enabled here (or a production host), `401` = wrong bearer, `422` = email outside the
pattern, `429` = over the hourly budget.

**Install the devproof build and hand it the token.** `devproof` is a Gradle BUILD TYPE (a clone of
`release`: same R8 and resource shrinking; `applicationId com.devino.caramel.devproof`, so it
installs beside the store app; signed with the DEBUG key, never the upload key; origin
`dev.grabcaramel.com`; label "Caramel DEVPROOF"). It is a build type, not a flavor, so the release
task names and outputs that `release-android-app.yml` calls by name do not change.

```bash
cd apps/caramel-android && ./gradlew assembleDevproof
adb install -r app/build/outputs/apk/devproof/app-devproof.apk
adb shell am start -n com.devino.caramel.devproof/com.devino.caramel.MainActivity \
  --es devproof_session "$TOKEN"
```

The app stores the bearer as if the sign-in had happened (`SessionStore.adoptDevProofBearer`),
confirms it with `/api/extension/me`, and links the web tabs. Then walk it: Saved and Account
tabs signed in, the Account and privacy dialog, delete account (`POST /api/account/delete` on dev),
and confirm the app returns to signed out. A malformed extra shows a notice instead of being
ignored.

**It must never ship.** Enforced by:

- `release-android-app.yml` may not mention devproof at all (`tests/unit/android-devproof-never-ships.test.ts`
  fails the build if it does), so no `android-v*` tag, dispatch or Play upload can build, sign or
  upload it. The variant is built only by `android-devproof-guard.yml`, which triggers on pull
  requests alone, holds no secrets and uploads nothing.
- `release-android-app.yml` runs `.github/workflows/scripts/android-release-dex-clean.sh` on the
  built store artifacts: on the unsigned APK in the verify job (every PR and tag run), and on the
  signed APK and AAB in the release job BEFORE the Play upload. It fails unless the applicationId
  is exactly `com.devino.caramel` and no dex holds the dev-only strings. The script (and the
  workflow) never spell the variant's name; its needles are assembled from halves.
- `.github/workflows/scripts/android-devproof-guard.sh` checks the BUILT artifacts on every PR
  that touches the app (running the same dex-clean script for the store build): the store APK keeps `com.devino.caramel` (no suffix) and its shrunk dex
  holds neither the `devproof_session` extra name nor the dev origin; the devproof APK has the
  suffix, holds both (so the check is proven able to see them) and is signed `CN=Android Debug`.
- Every app code path is behind the constant `BuildConfig.DEV_PROOF` (false outside the devproof
  build), so R8 strips it from release.

## Email delivery health (async provider failures)

Two different failures lose transactional mail, and until 2026-09-16 the app
only knew about one of them:

1. **The send is refused.** `sendEmail()` throws, `src/lib/auth/auth.ts` reports
   it to Sentry, flushes and rethrows (`surface: auth-verification-email` /
   `auth-reset-password-email`). Already loud, unchanged.
2. **The send is ACCEPTED and then fails.** Sendly answers `202` (`PENDING`),
   SES takes the message, and it is later marked `BOUNCED` / `FAILED` /
   `REJECTED` / `RENDERING_FAILURE` (or the recipient files a spam complaint,
   `complainedAt`) — or it never leaves `PENDING` / `SENDING`. Nothing in the
   app ever learned about this: on the previous provider (useSend,
   retired 2026-10-20) grabcaramel.com's log held 55 `BOUNCED` and 2 `FAILED`
   rows that reached no Sentry issue and no human.

`src/lib/emailDeliveryHealthMonitor.ts` closes (2). Once per interval the server
reads Sendly's OWN email list (`GET /api/emails`, newest first, cursor-paged via
`sendly.emails.list`; rows whose `from` is not our sending domain are skipped),
classifies the window, and raises **exactly
one** Sentry event per bad clock hour:

| Window contains                | Sentry                                                 |
| ------------------------------ | ------------------------------------------------------ |
| only `DELIVERED`/`SENT`/…      | nothing (one `[email-health] ok …` log line)           |
| any failure status             | `Transactional email delivery degraded`, level `error` |
| only stuck/delayed sends       | same message, level `warning`                          |
| page budget ran out (gap)      | `…health check incomplete`, level `warning`            |
| provider unreachable / refused | `…health check failed`, level `error`                  |

The event carries counts, statuses, the window and the sender domain — **never** a
recipient, subject or body. The list rows' PII fields are dropped at the parse
boundary (`toEmailLogEntry`).

**Schedule.** Caramel has no cron and no worker, so this is an `unref`'d
interval started from `instrumentation.ts`'s `register()` — one process, one
schedule. The first run happens one interval AFTER boot (a crash-looping
container must not be able to machine-gun Sentry), and the Sentry throttle is
one event per clock hour per process. If the web service ever scales past one
replica, move this to a real scheduler rather than adding a lock.

**Config.** `EMAIL_DELIVERY_HEALTH_ENABLED` is unset by default, which means ON
in production whenever `SENDLY_API_KEY` is set and OFF everywhere else; `false`
opts a prod deploy out, `true` forces it on locally. The window length equals
`EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES` (default 60). Boot logs the decision
either way:

```
[boot] email delivery health ENABLED — production default
```

**On demand.** The same check runs as a one-shot, from inside the prod container
or anywhere the `SENDLY_*` vars exist (it reads `process.env` directly and does
NOT need `DATABASE_URL`). Exit code 0 = healthy/skipped, 1 = degraded, incomplete
or unreachable:

```bash
pnpm --filter caramel-app run email:health -- --minutes 1440
# [email-health] ok window=… scanned=152 failed=0 delayed=0 stuck=0 (DELIVERED=152)
```

**Key scopes.** The key needs `emails:send` (sending) and `emails:read` (the
check lists sent mail); without `emails:read` the check is a permanent `error`
report.

**Shared project.** grabcaramel.com lives in the shared Sendly "Devino" project
(other Devino apps send from it too) and a key cannot be limited to one domain.
So the check is always pinned to `SENDLY_FROM_EMAIL`: the list query is
narrowed with Sendly's `from` filter (exact match on the bare address), rows
are re-filtered to the sender domain, and with no usable sender the check
refuses to run (`error`) instead of scanning the whole project.
`SENDLY_FROM_EMAIL` is zod-validated as an email address at boot.

**Incomplete coverage.** If the page budget (10 pages x 50 rows) runs out before
the start of the window, the result is `incomplete` - reported to Sentry (level
`warning`) and a non-zero exit from `email:health` - never `ok`. A window that
also contains a bad row stays `degraded`.

**If it reports degraded:** open Sendly (docs: https://docs.sendly.now) for the
affected window — the counts in the Sentry event tell you which class.
`BOUNCED` in bulk usually means a recipient-side or reputation problem (Sendly's
`deliverability` reports: `sendly.deliverability.diagnose`); `FAILED` /
`REJECTED` in bulk usually means SES or the domain's verification (the domain's
`dkimStatus`/`spfStatus` must be verified); a pile of stuck `PENDING` /
`SENDING` means Sendly accepted mail it is not draining.

**Sendly text part.** Sendly's send API takes one HTML `body` and no separate
plain-text part, so mail goes out HTML-only (a text-only caller is rendered to
escaped HTML in `src/lib/email.ts`).

## Privacy-policy commitments (log retention, account deletion)

The public privacy policy (`/privacy`) promises two operational things; keep them true.

- **Server logs are kept up to 90 days (an upper bound; the real figures are shorter).** What exists, checked 2026-10-25 against `origin/main` and the Dokploy host:
    - **Container stdout/stderr** (the app's `console.*`): `json-file` rotation `max-size: 10m`, `max-file: 3` on every service (root `docker-compose.yml`), so about 30 MB per service. How many days that covers depends on log volume and has not been measured. It holds no request URLs: nothing in the app logs `req.url`, and the three search routes log a caught error only after `withoutSearchText` (`src/lib/api/withoutSearchText.ts`). A new compose service MUST carry the same `logging:` block.
    - **Traefik access log: OFF** on the Dokploy host (the "Requests" setting; verify with `settings-haveActivateRequests`). So the query string of a request (`/api/coupons/stores?q=`, `/api/coupons?search=&key_words=`) is NOT in any proxy log today. If it is turned on, Dokploy's log cleanup (cron `0 0 * * *`, `settings-getLogCleanupStatus`) keeps only the last 1000 lines of it, which is not a retention guarantee in either direction.
    - **Sentry (self-hosted)** is the copy that lasts: transactions, breadcrumbs and error requests carry URLs. `src/lib/sentryPiiScrub.ts` redacts the `q`, `search`, `key_words` and `query` params (`tests/unit/sentry-search-text-scrub.test.ts`), so the typed text is not stored there. Session Replay frames (recorded fetch and navigation URLs) go through the same scrub via `beforeAddRecordingEvent` (`scrubReplayRecordingEvent`). Sentry event retention is **90 days** (`SENTRY_EVENT_RETENTION_DAYS=90` in the DevinoSolutions/sentry-selfhost `.env`); it is set there, not in this repo.
    - **Known exception to the 7-day policy (MASTER decision 2026-10-25, no purge):** Sentry events captured BEFORE this scrub reached production may still hold typed store-search text (URLs in transactions, breadcrumbs, request blocks, error messages). They are deliberately not purged (a purge is lossy and partial, and would delete error history); they age out under the 90-day retention. Cutoff = 2026-10-25, when the scrub (T-7505 PR #504) went live on production (deploy of main 697d229, 06:09:50Z). Pre-cutoff events age out by 2027-01-23 at the latest (cutoff + 90 days). Events captured after the cutoff are covered by the scrub above (Replay DOM snapshots are not passed through it; they rely on the mask options).
    - **PostHog session recordings** record each page request's URL (performance capture is on for project 6), so they can carry store-search text. `session_recording.maskCapturedNetworkRequestFn` (`src/lib/analytics/recordingNetworkScrub.ts`, wired in `src/lib/analytics/identity.ts`) runs the same `redactSensitiveText` as the Sentry scrub on every recorded request URL and string body/header (`tests/unit/posthog-recording-network-scrub.test.ts`). Page URLs (`$current_url`, `$pageview`) do not carry search text: no page puts it in its address, the search boxes call the API directly.
    - **PostHog recordings: retention setting is 30d (not yet observed on a new recording); pre-scrub recordings deleted in the app; MinIO purge of their exclusive objects done 2026-10-25, shared objects pending (A78); backup copies pending.** Project 6 `session_recording_retention_period` is `30d` since 2026-10-25 07:56Z (it was `5y`). The posthog-selfhost maintainer set it server-side, because our self-hosted org has no SESSION_REPLAY_DATA_RETENTION feature and the API/UI PATCH returns 500 "Invalid retention entitlement" for any value. To change it again, ask posthog-selfhost; don't retry the PATCH. Retention is stamped on each recording at ingest (`retention_period_days`), so changing the setting does NOT shorten recordings that already exist. New recordings should leave the product (UI/API) after 30 days once stamped 30 (none observed yet; existing ones keep 1825). Whether expiry removes the stored snapshot blobs is unknown (follow-up T-8392). The recording network-URL scrub (PR #508) went live on production 2026-10-25 07:30:23Z (deploy of main 056e37d8). The 588 project-6 recordings that started before the scrub went live were deleted in PostHog on 2026-10-25 (MASTER decision 2026-10-25) through the API (`DELETE /api/environments/6/session_recordings/<id>/`); each was verified to return 404 afterwards, so they can no longer be played back. The API delete removes only the Postgres row and sends a Kafka deletion event: the snapshot data (stored unencrypted) still physically exists in object storage (MinIO bucket `posthog`, under the 5y prefix) and in the B2 offsite mirror (see below). 847 objects are exclusive to those sessions; 3,344 are shared batch files that also hold other teams' sessions. The 847 MinIO objects holding only those sessions (75.7 MB) were physically deleted by posthog-selfhost on 2026-10-25 08:16Z (MASTER go; MinIO is unversioned, all 847 verified gone); the B2 offsite copies are NOT yet guaranteed to expire: the 847 originals sit in the offsite deleted folder (dated 2026-10-25, pruned after 30 days), but B2 also kept about 830 hidden old versions at the original paths, which our prune does not touch and which expire only if the B2 bucket has a lifecycle rule for hidden versions (Amin asked to check/fix it or approve a one-off delete). The 3,344 objects shared with other projects' recordings are NOT purged; zero-filling our byte ranges awaits Amin (A78). We never purge the B2 offsite mirror directly; a MinIO deletion reaches B2 only through the mirror's deleted-folder prune (30 days) plus whatever B2 lifecycle rule applies to hidden versions, which is unconfirmed. Follow-ups: T-8391 (a real keystore, so deletes become true crypto-shreds) and T-8392 (what retention expiry does to stored blobs). Until the purge is complete this remains a known exception to the 7-day store-search-text policy; there is no age-out bound for the pre-scrub blobs: the shared objects in MinIO (5y prefix), and their B2 mirror copies including hidden old versions (no lifecycle rule confirmed). TODO(T-8398, T-8392): shared-object purge and B2 hidden-version expiry (A78, T-8398) + confirm expiry behaviour (T-8392); until all are done, do not claim recording data is gone.
    - **Before anyone turns on Traefik access logs ("Requests" in Dokploy), a scrub job must exist first** that removes query strings older than 7 days (MASTER policy 2026-10-24: store-search text is kept at most 7 days). Do not enable them without it.
- **Account deletion is self-serve** (T-7505): "Delete my account" on `/profile` (Data & privacy) and in the native apps both call `POST /api/account/delete`, which in one transaction deletes the `users` row (the DB cascades sessions, accounts, savings_events, favorite_stores and coupon_reports; shared coupons are set to `submitted_by_user_id = NULL`), scrubs `site_suggestions.requester_email` and `user_agent` (not cascaded; matched by `siteSuggestionIdentityWhere` in `src/lib/siteSuggestionIdentity.ts`) and erases the account's `verification_tokens`, then deletes the PostHog person (next section). "Delete my data" (`POST /api/account/data/delete`) only empties the synced data and keeps the login. **A request by email to hello@devino.ca** (someone who cannot sign in) is still handled within 30 days by hand: verify the requester writes from the account's address, then do exactly what the route does: delete the `users` row, scrub that address in `site_suggestions` and `verification_tokens`, and delete the PostHog person (manual recovery steps below).

## Account deletion: the PostHog person (T-7505)

`POST /api/account/delete` deletes the user's PostHog person and events after the database commit (`src/lib/analytics/posthogPersonDeletion.ts`). It is the only part of account deletion that needs a secret the capture path does not.

- **Env (deploy env only, both optional at boot):** `POSTHOG_PERSONAL_API_KEY` (a personal API key scoped to `person:write` only) and `POSTHOG_PROJECT_ID` (the numeric id of the project `POSTHOG_DATASET` captures into). The API host is `NEXT_PUBLIC_POSTHOG_HOST`. Create the key under PostHog > Settings > Personal API keys, scope `person:write`, restricted to the Caramel project.
- **Unset is a defect, not a mode:** the account is still deleted, but every deletion then sends a Sentry error (`operation: posthog_person_delete`, `reason: not_configured`) and the response carries `analyticsDeletion: "failed"`. `POSTHOG_DATASET=disabled` is the one quiet case (`not_applicable`, logged).
- **What it does:** `POST /api/projects/{id}/persons/bulk_delete/` with the user id as the only distinct id, `delete_events` and `delete_recordings` true. PostHog answers 202 and removes the person, events and recordings in the background; the response means "queued", not "gone". Only events captured before the request are deleted.
- **Other ids:** only the user id is sent. `identify(user.id)` merges the browser's earlier anonymous id into that person, so the whole person goes. Anonymous ids of signed-out visits that never signed in, `extension_installed` events keyed by install id, and diagnostics events under the extension's random device id are not linked to the account and are not deleted.
- **No durable retry:** the call runs once, inline, after the database commit. If the process dies between the commit and the PostHog call (deploy, OOM, crash), the PostHog delete is lost and nothing re-queues it; a PostHog error or outage leaves the same gap, with a Sentry event. The account row is gone by then, and the Sentry event holds only `userHash` (a short SHA-256 of the user id, no email), so nothing in the app can redo it. A 404 from PostHog is reported as `http_error` (a wrong project id, host or key scope), not treated as success: a missing person answers 202 with `persons_found: 0`.
- **Manual recovery (production is PostHog project 6):** the person is findable because the browser's identify (and the server's extension sign-up path) sets `email`, `$email` and `rc_app_user_id` (the user id, which is also the distinct id) on it. (1) If you know the email (the user wrote in), search People for it. (2) Otherwise list persons that still have `rc_app_user_id` (for example a HogQL query on `persons`), hash each value with SHA-256, keep the first 12 hex characters, and match the Sentry `userHash`. (3) Delete that person with events and recordings (People > Delete person and events, or the same `bulk_delete` call with the id as `distinct_ids`). A person with no such properties was never identified, so it is not linked to any account and was never in scope.
- **Failures:** read them in Sentry by `operation: posthog_person_delete`; the tags carry the `reason` (`not_configured`, `bad_project_id`, `http_error`, `deletion_errors`, `request_failed`).
- **Live check:** `tests/integration/posthog-person-deletion.itest.ts` (skipped unless the `POSTHOG_PERSON_DELETE_ITEST_*` variables for a scratch project are set; never the production project, and project id 6 is refused outright).

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

| Var                                                    | Used for                                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                         | auth_db + the app-owned coupon catalog (Prisma) — required                                                                                                                             |
| `COUPONS_DATABASE_URL`                                 | OPTIONAL, bridge-sync only — read-only external `caramel_coupons` connection string; unset in normal deploys                                                                           |
| `INGEST_API_KEY`                                       | bearer for `POST /api/ingest/catalog` (the coupons pipeline supplier push) — server-to-server, never a client                                                                          |
| `COUPONS_ADMIN_SECRET`                                 | bearer for `POST /api/coupons/expire` + rate-limit trust exemption                                                                                                                     |
| `UPKUMA_HEALTH_SECRET`                                 | bearer for `GET /api/health/db`                                                                                                                                                        |
| `OPENROUTER_API_KEY`                                   | extension cart classifier (`/api/classify-cart`) — unset throws a named `OpenRouterError`, not a silent no-op                                                                          |
| `NEXT_PUBLIC_SENTRY_DSN`                               | Sentry init (client + server) — unset means Sentry never initializes, production or not                                                                                                |
| `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Sign in with Apple: the app signs its own client-secret JWT from these (required when `APPLE_CLIENT_ID` is set; `.p8` as one line with literal `\n`) — see "Apple sign-in fails" above |

TODO(human): record where these are actually set/rotated in Dokploy (env
var UI vs. secret store) and the rotation procedure for
`COUPONS_ADMIN_SECRET` / `UPKUMA_HEALTH_SECRET` — not derivable from this
repo.

## Paid fallback

The optional server-only org key (`OPENROUTER_FALLBACK_API_KEY`) can only ever be sent to https://proxyai.devino.ca, with an 8-second default wait (`OPENROUTER_FALLBACK_AFTER_SECONDS`, at most 12) and boot validation that names a bad variable but never prints its value. Today no request sends it: both production AI surfaces (the 7-second cart classifier and the coupon-box pick) are guest-reachable, and guests never get the paid path, so setting the key changes nothing and the worst case is 0 paid requests per user per day and 0 per deployment. The canonical helper (`src/lib/proxy-fallback-headers.ts`) and env reader (`src/lib/proxy-fallback-env.ts`) stay so a future signed-in caller can wire in through the reader: its client deadline must be at least 20 seconds (`MIN_PAID_PATH_DEADLINE_SECONDS`: the longest 12-second wait plus 8 seconds for the paid answer), its request must use `fetchWithoutRedirects` so the key never follows a 3xx off the proxy, it must make one request with no retries, and it must come with wiring and trace tests through its real route. The reader logs one warning (without the value) when the key is set but the base URL is not the proxy. The key's $5/week limit, set in OpenRouter, is the only hard cap; the vars are blanked in evals and E2E.

## coupon-box pick: switch on / kill switch

`POST /api/extension/coupon-box-pick` (paid, LLM-backed; `couponBoxPick.ts`) is
off by default. Spend is bounded by three in-memory buckets on uncached model
calls only (cache hits are free): 20 calls / 10 min per client, 600 / hour for
the process, and a per-day cap, `COUPON_BOX_PICK_DAILY_CAP` (default 2000).
Past any of them the route answers `429` and the extension carries on as if the
rules found nothing. A global or daily trip sends ONE Sentry warning per window
(`coupon-box-pick global|daily model-call budget exhausted`).

**Switch on.** Set `COUPON_BOX_PICK_MODEL` (an eval-gated model id) and
`COUPON_BOX_LLM_ENABLED=true`, optionally `COUPON_BOX_PICK_DAILY_CAP=<n>`, then
redeploy. The extension reads the same condition from `GET /api/extension/features`.

**Kill switch.**

- Hard kill: `COUPON_BOX_LLM_ENABLED=false` and redeploy. The route then answers
  `200 {outcome:'no_pick', reason:'disabled'}` without reading the body or
  calling a model, and the features endpoint stops advertising it.
- Spend stop, feature still answering from cache: `COUPON_BOX_PICK_DAILY_CAP=0`
  and redeploy. The first uncached model call is refused (`429`), so no model
  call is made; cached answers still serve. A blank value reads as the default
  (2000), not 0; a negative or non-integer value fails boot.
- The buckets are per process (one web instance) and reset on restart, so a
  redeploy also starts a fresh day's count.

**Read it.** Every request that reaches the handler emits the PostHog event
`coupon_box_pick_outcome` (properties: `outcome`, `cached`, `latency_ms`,
`model_ms` when a model was called, `store`, `model`). Requests refused earlier
by withRoute (non-extension Origin 403, generic rate limit 429) emit nothing.
`outcome` is one of `box`, `no_box`, `no_pick:disabled`, `no_pick:model_error`,
`no_pick:unparsable`, `no_pick:refused_button`,
`budget_exceeded:client|global|daily`, `too_large`,
`invalid`, `server_error` (`COUPON_BOX_PICK_OUTCOMES` in
`src/lib/analytics/couponBoxPickOutcome.ts`).
`no_pick:refused_button` is the whole answer refused, not only its button. An
answer that names a good toggle and no input, but also names an apply button
the server refuses (checkout, place order, a gift card or store credit
control), is discarded with its toggle: the extension gets nothing for that
page, though the toggle alone would have opened the box.

Outcome mix, last 24h:

```sql
SELECT properties.outcome AS outcome,
       count() AS requests,
       countIf(properties.cached = true) AS cache_hits
FROM events
WHERE event = 'coupon_box_pick_outcome'
  AND timestamp >= now() - INTERVAL 24 HOUR
GROUP BY outcome
ORDER BY requests DESC
```

Latency, last 24h (`latency_ms` = whole request in the handler; `model_ms` =
model call only, present on requests that made one):

```sql
SELECT count() AS requests,
       quantile(0.5)(toFloat(properties.latency_ms)) AS latency_p50_ms,
       quantile(0.95)(toFloat(properties.latency_ms)) AS latency_p95_ms,
       countIf(properties.model_ms IS NOT NULL) AS model_calls,
       quantileIf(0.5)(toFloat(properties.model_ms), properties.model_ms IS NOT NULL) AS model_p50_ms,
       quantileIf(0.95)(toFloat(properties.model_ms), properties.model_ms IS NOT NULL) AS model_p95_ms
FROM events
WHERE event = 'coupon_box_pick_outcome'
  AND timestamp >= now() - INTERVAL 24 HOUR
```

Reading it: many `budget_exceeded:daily` means the cap is too low for real
traffic (re-size it) or someone is forging the extension Origin; a rising
`no_pick:model_error` with a high `model_p95_ms` is the model timing out
(`TIMEOUT_MS` is 20s).
