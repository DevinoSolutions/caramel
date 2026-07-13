# Empirical 3AM Incident Walkthrough — caramel

**Run:** 3AM-INCIDENT empirical test · dev @ `537547b3081aa3a0ec817cdc5f6dac4f0d328dbb` · READ-ONLY, no prod hits, paper exercise against repo contents only.

**Scenario:** 3am. Users report the extension finds no coupons on ANY store since ~an hour ago; some report the web app's `/coupons` page is empty. Cold on-call engineer, repo access, prod-dashboard access ONLY if the repo says where.

Scope confirmed against `audit/exclusions.md` before starting; nothing quoted below falls inside an excluded path.

---

## Step 1 — Where does the repo tell you to look first?

Nowhere. An exhaustive search of the 405 tracked files for anything named `runbook`, `incident`, `oncall`/`on-call`, or `health*` (outside `node_modules`) returns **zero** hits except one file: `apps/caramel-app/src/app/api/health/db/route.ts`. There is no `RUNBOOK.md`, no incident-response doc, no on-call doc, no architecture doc, no status-page reference, no link to a dashboard.

The closest thing to ops documentation is the root `README.md`, and its CI/CD section is one line:

```
README.md:70-72
## CI/CD

The project uses GitHub Actions for CI/CD. The workflow is defined in `.github/workflows/`.
```

That's it — no mention of where the app is deployed, how to check its status, or what to do when it's down. `local-dev/LOCAL-DEV.md` exists but is scoped entirely to local dev ports/compose, not production.

The one health endpoint that exists is gated behind an undocumented secret (`UPKUMA_HEALTH_SECRET` — see AM-3), so even finding it in source doesn't let a cold on-call engineer call it. **A cold engineer's only real option, using solely what the repo provides, is to start reading `apps/caramel-app/src/app/api/coupons/**` source code from scratch at 3am\*\* — there is no faster path the repo hands them.

---

## Step 2 — Trace: extension request → API route → DB, and what evidence each hop leaves

**Hop 1 — extension → background service worker.** `popup.js` (and the auto-insert path in `background.js`) call the shared `fetchCoupons()` helper, which delegates the actual network call to the extension's background/service-worker context via `runtime.sendMessage`:

```
apps/caramel-extension/background.js:177-204
} else if (message.action === 'fetchCoupons') {
    const { site, kw, category } = message
    const url = new URL(caramelUrl('api/coupons'))
    url.searchParams.set('site', site)
    ...
    fetchWithTimeout(url.toString())
        .then(async r => {
            if (!r.ok) return { coupons: [] }
            const json = await r.json()
            return { coupons: Array.isArray(json) ? json : json.coupons || [] }
        })
        .then(resp => sendResponse(resp))
        .catch(err => sendResponse({ coupons: [], error: String(err) }))
```

Evidence left behind on the client for a non-2xx response (500, 503, 429, etc.): **none.** No `console.error`, no dev-gated `log()` call, nothing — `if (!r.ok) return { coupons: [] }` is the entire handling. A genuine backend outage and a genuine "no coupons for this site" are byte-for-byte the same object returned to the caller. Only a hard network-level exception (DNS failure, timeout, connection refused) reaches the `.catch`, which at least tags `error: String(err)` — but even that is only surfaced through `log()`, which is a no-op in every production (Web Store / signed) install (Step 5).

**Hop 2 — API route → coupons DB.** `apps/caramel-app/src/app/api/coupons/route.ts` queries a _separate_ Postgres database via `couponsSql` (not the Prisma client used for auth):

```
apps/caramel-app/src/lib/couponsDb.ts:3-11
// Read-only connection to the `caramel_coupons` database owned by the
// Python verification service. All mutations to the coupon catalog flow
// through that service — Next.js only reads (plus two narrow mutations:
// usage-increment and expire, both exposed to the extension).
import postgres from 'postgres'

const connectionString = process.env.COUPONS_DATABASE_URL
if (!connectionString) {
    throw new Error('COUPONS_DATABASE_URL is not set')
}
```

On failure, the route's only trace is:

```
apps/caramel-app/src/app/api/coupons/route.ts:120-125
} catch (error) {
    console.error('Error fetching coupons:', error)
    return NextResponse.json(
        { error: 'Error fetching coupons.' },
        { status: 500 },
    )
}
```

This is one of **19** distinct `console.error(...)` call sites across `apps/caramel-app/src/app/api/**`, each with its own free-text message, no shared schema, no request/correlation ID, no severity tag. The real Postgres error (e.g. connection-refused, timeout, auth failure) _is_ in that string — but it only exists as unstructured stdout, reachable solely by opening the Dokploy container-log viewer (not referenced anywhere in the repo) and free-text-searching 19 unrelated call sites for the right one. Nothing routes it anywhere proactive.

**Hop 3 — web app's own `/coupons` page.** This is client-fetched (`'use client'`), and unlike the extension it _does_ distinguish HTTP failure from empty result:

```
apps/caramel-app/src/components/coupons/coupons-section.tsx:122-124
const res = await fetch(`/api/coupons?${params}`)
if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`)
}
```

...caught below and surfaced as `toast.error('Failed to load coupons')` + `console.error`. So the aggregate `/coupons` page is strictly better-instrumented than the extension for the exact same outage — but the per-store SSR page (`apps/caramel-app/src/app/(marketing)/coupons/[store]/page.tsx:118`) calls `fetchStoreCoupons()` → `couponsSql` **with no try/catch at all**, so a DB failure there throws all the way to Next's default error boundary (there is no local `error.tsx` or `global-error.tsx` anywhere in the app — confirmed by glob). Three surfaces, three different failure presentations, for the identical outage: extension = false "unsupported site", aggregate page = toast + empty grid, per-store page = raw framework error page.

---

## Step 3 — Can you tell DB outage vs. bad deploy vs. API contract break, using only repo-provided signals?

**No, not reliably.** Concretely:

- **No build/version signal.** There is no `/api/version`, no exposed git SHA or build ID, no Sentry release-creation step in any workflow. On-call cannot ask the running app "what commit are you," so "was this a deploy an hour ago" can only be answered by cross-referencing GitHub commit timestamps against Dokploy's own deploy history — external to the repo, and imprecise since Dokploy's build queue time ≠ commit time.
- **No deploy pipeline in the repo at all.** All three workflows (`checks-app.yml`, `checks-extension.yml`, `release-extension.yml`) are CI-only — lint/type-check/build/Playwright+Argos E2E for the app, packaging for the extension. None deploys anywhere, none references Dokploy, none runs a post-deploy smoke test. A grep for `dokploy` (case-insensitive) across the entire tracked tree returns **zero** hits. So "bad deploy" as a hypothesis can't even be confirmed/ruled out from the repo — there's no CI step that would have caught a broken coupons-DB contract before it shipped, and no log of what "deploy" even means for this app.
- **API contract break is plausible and would look identical to a DB outage.** `couponsSql` typed rows (`CouponRow`, `Row` in `supported-stores/route.ts`) are hand-maintained against a DB schema this repo does not own or version (Prisma's `schema.prisma` only models `Account`/`Session`/`Verification`/`User` — no `Coupon` model; the coupons schema lives entirely in the separately-owned Python verification service, invisible here). A column rename or type change on that side throws inside the same try/catch as a real connection failure, producing the identical generic `{ error: 'Error fetching coupons.' }` / 500. The repo gives no way to distinguish "DB is down" from "DB is up but the query is now wrong" other than reading the raw exception string in container logs (see Step 2).
- **The one health check that exists checks the wrong database** (AM-2) — so even the most basic instinct, "check the health endpoint," produces a false-positive "database: ok" while the coupons DB the incident is actually about could be completely unreachable.

---

## Step 4 — What's the rollback story the repo documents?

**None.** There is no rollback documentation, no rollback script, and no deploy workflow to roll back _from_ — the repo shows no evidence of how `grabcaramel.com` / `dev.grabcaramel.com` actually gets new code (Dokploy presumably auto-deploys on git push, per the task's own framing, but that wiring lives entirely in the Dokploy dashboard, outside this repo). `apps/caramel-app/nixpacks.toml` only defines the build/start recipe:

```
apps/caramel-app/nixpacks.toml:1-14
[phases.setup]
nixPkgs = ["nodejs_20", "pnpm"]
[phases.install]
cmds = ["pnpm install --no-frozen-lockfile"]
[phases.build]
cmds = ["pnpm run build"]
[start]
cmd = "pnpm run start"
```

No container healthcheck directive (contrast with `local-dev/docker-compose.yml`, which _does_ declare `healthcheck:` blocks for its Postgres/Redis services — the discipline exists for local dev infra but was never extended to the app's own deploy config, so Dokploy has no automatic "this container is unhealthy, don't route to it / restart it" signal for the app itself).

For the **extension**, rollback is even harder and the repo says nothing about it: Chrome/Firefox/Edge releases go through store review (no instant kill switch), and a grep for any remote-config / feature-flag / kill-switch mechanism in `apps/caramel-extension` returns nothing. If a bad extension version ships, the only lever is a new store submission and waiting for review — nothing in the repo acknowledges this or documents a mitigation (e.g., a server-side capability flag the backend could use to make old extension versions degrade gracefully).

---

## Step 5 — Would Sentry have the trace? Does the extension's failure surface anywhere?

**App side: Sentry is genuinely wired for _unhandled_ errors, but the coupons failure path never reaches it.** `instrumentation.ts` wires Next's request-error hook to Sentry:

```
apps/caramel-app/src/instrumentation.ts:12
export const onRequestError = Sentry.captureRequestError
```

This fires for exceptions that escape a route handler unhandled. But `/api/coupons`, `/api/coupons/increment`, `/api/extension/supported-stores`, `/api/coupons/stats`, `/api/coupons/filters`, `/api/coupons/stores` — every coupons-adjacent route — catches its own error and returns a normal `NextResponse.json(..., {status: 500})` (Step 2 quote). That is a _handled_ response, not an unhandled exception, so `onRequestError` never fires and Sentry never sees it. A full-text search of `apps/caramel-app/src` for `captureException` / `Sentry.` outside the config/instrumentation files themselves returns **zero** call sites — nowhere in the app does a catch block explicitly forward to Sentry. The one code path that _would_ actually reach Sentry is the per-store SSR page (`[store]/page.tsx`), precisely because it has no local try/catch (Step 2) — an accident of omission, not a deliberate design choice, and it only covers one of three affected surfaces.

Client-side (browser) Sentry is also initialized with session replay:

```
apps/caramel-app/src/instrumentation.client.ts:6-26
Sentry.init({
    dsn,
    integrations: [ Sentry.replayIntegration({ ... }) ],
    tracesSampleRate: 1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    ...
})
```

But `coupons-section.tsx`'s catch block only does `toast.error(...)` + `console.error(...)` — no `Sentry.captureException`, no rethrow — so this well-configured "replay on error" setup never actually triggers for this exact failure either. The DSN and self-hosted Sentry URL (`sentry.devino.ca`, `org: devino`, `project: caramel` in `next.config.mjs:50-52`) are the one genuinely useful, discoverable-from-repo signal — if this event ever reached it, on-call would know where to look — but for this specific incident it won't have anything, so an on-call engineer who does check Sentry first (correctly, per the infra that exists) will find a clean dashboard and can be misled into ruling out the backend entirely.

**Extension side: no error reporting exists at all.** There is no Sentry (or any) SDK in `apps/caramel-extension` — a grep for `sentry` (case-insensitive) across the whole extension returns zero hits. The only "telemetry" is `recordTiming()`, and it never leaves the device:

```
apps/caramel-extension/shared-utils.js:52-65
var recordTiming = (event, meta = {}) => {
    try {
        const entry = { event, t: performance.now(), meta }
        if (currentBrowser && currentBrowser.storage && currentBrowser.storage.local) {
            currentBrowser.storage.local.get(['caramel_timings'], res => {
                const arr = (res && res.caramel_timings) || []
                arr.push(entry)
                currentBrowser.storage.local.set({ caramel_timings: arr })
            })
        }
    } catch (e) { /* ignore storage errors */ }
}
```

And even the local `log()` calls that _would_ narrate the failure (`log('fetchCoupons background error', resp.error)`, `log('Fetched', d.length, 'coupons')`) are compiled to a no-op in every real user's browser:

```
apps/caramel-extension/shared-utils.js:48-50
var log = _isDevInstall()
    ? (...a) => console.log('Caramel:', ...a)
    : () => {}
```

`_isDevInstall()` is true only for unpacked/dev installs (no `update_url` in the manifest) — i.e. **false for every Chrome Web Store / AMO / App Store user actually affected tonight.** So: no crash reporting, no remote telemetry, and even manual console inspection by a technical end user yields nothing on the HTTP-error path. The failure is, for all practical purposes, invisible outside of aggregate user complaints reaching support. The one place it _is_ user-visible is the UI text itself, and it actively points the wrong direction:

```
apps/caramel-extension/popup.js:151
<h3>No coupons for this site yet</h3>
```

— shown identically whether the site genuinely has no coupons or the entire backend is down.

---

## CANDIDATE FINDINGS

{"id":"AM-1","location":"README.md:70-72","quote":"The project uses GitHub Actions for CI/CD. The workflow is defined in `.github/workflows/`.","what":"No runbook, incident-response doc, on-call doc, or dashboard pointer exists anywhere in the 405 tracked files.","why_it_matters":"Cold on-call has zero repo-provided starting point at 3am; must reverse-engineer the whole system from source under pressure.","severity":"High","confidence":0.95,"fix_direction":"Add a RUNBOOK.md covering: services/DBs, dashboards (Dokploy/Sentry URLs), health checks, common failure signatures, escalation.","effort":"M","category":"operability"}
{"id":"AM-2","location":"apps/caramel-app/src/app/api/health/db/route.ts:9-11","quote":"const result = await timedCheck('database', async () => {\n await prisma.$queryRaw`SELECT 1`\n })","what":"The only health endpoint checks the Prisma/auth DB; it never touches `couponsSql`/`COUPONS_DATABASE_URL`, the DB actually serving coupons.","why_it_matters":"During exactly this incident, the health check would report 200 'ok' while the real broken dependency is untested — a false-negative that actively misdirects on-call.","severity":"Critical","confidence":0.95,"fix_direction":"Add a second timedCheck against couponsSql (SELECT 1) and report both services independently from /api/health.","effort":"S","category":"operability"}
{"id":"AM-3","location":"apps/caramel-app/src/lib/health.ts:31-36","quote":"export function authorize(request: Request): boolean {\n const secret = process.env.UPKUMA_HEALTH_SECRET\n if (!secret) return false\n const auth = request.headers.get('authorization') || ''\n return auth === `Bearer ${secret}`\n}","what":"UPKUMA_HEALTH_SECRET gates the health endpoint but appears nowhere else in the repo — not in .env.example, not in CI, not in any doc.","why_it_matters":"Even a cold engineer who finds the health route by reading source has no repo-given way to obtain or know about the secret needed to call it.","severity":"Medium","confidence":0.9,"fix_direction":"Document the secret's purpose/owner in .env.example (name only, no value) and in the runbook (which monitor calls it, where).","effort":"S","category":"operability"}
{"id":"AM-4","location":"apps/caramel-app/src/lib/couponsDb.ts:9-12","quote":"const connectionString = process.env.COUPONS_DATABASE_URL\nif (!connectionString) {\n throw new Error('COUPONS_DATABASE_URL is not set')\n}","what":"COUPONS_DATABASE_URL is required but absent from .env.example, ci-env.ts, and local-dev/docker-compose.yml (which only provisions the auth Postgres + Redis).","why_it_matters":"The DB actually implicated in this incident cannot be provisioned, inspected, or even discovered locally from this repo; CI never exercises this code path either.","severity":"High","confidence":0.95,"fix_direction":"Document COUPONS_DATABASE_URL in .env.example and add a coupons-db stub (or clear pointer to the owning Python service repo) to local-dev.","effort":"M","category":"operability"}
{"id":"AM-5","location":"apps/caramel-app/src/app/api/coupons/route.ts:120-125","quote":"} catch (error) {\n console.error('Error fetching coupons:', error)\n return NextResponse.json(\n { error: 'Error fetching coupons.' },\n { status: 500 },\n )\n }","what":"Errors are caught and converted to a normal JSON response, so Next's onRequestError/Sentry.captureRequestError hook never fires; no captureException call exists in this or any sibling coupons route.","why_it_matters":"Sentry is fully wired for unhandled errors app-wide, yet the exact route implicated tonight is structurally invisible to it — zero alert, zero trace, despite working observability infra.","severity":"Critical","confidence":0.9,"fix_direction":"Call Sentry.captureException(error) in every coupons-route catch block, or centralize via a shared handler wrapper.","effort":"S","category":"operability"}
{"id":"AM-6","location":"apps/caramel-extension/background.js:191-193","quote":"fetchWithTimeout(url.toString())\n .then(async r => {\n if (!r.ok) return { coupons: [] }","what":"Any non-2xx response from /api/coupons (500, 503, 429...) is silently converted to an empty coupons array with no logging at all, not even a dev-gated log() call.","why_it_matters":"This is the exact mechanism of the reported symptom: a full backend outage is indistinguishable, at every layer above this line, from 'this store legitimately has no coupons.'","severity":"Critical","confidence":0.95,"fix_direction":"Preserve status/error info in the response (e.g. {coupons:[], error:`HTTP ${r.status}`}) so callers can distinguish failure from empty, matching the fetchSupportedStores/classifyCart handlers' partial pattern.","effort":"S","category":"operability"}
{"id":"AM-7","location":"apps/caramel-extension/popup.js:151","quote":"<h3>No coupons for this site yet</h3>","what":"The UI shown for a swallowed backend failure is identical to the UI shown for a genuinely unsupported site — actively telling the user the wrong thing.","why_it_matters":"Users experiencing a total outage are told 'we don't support this store' rather than 'something's wrong,' suppressing the very complaints that would otherwise triangulate the incident faster.","severity":"High","confidence":0.9,"fix_direction":"Branch on the error flag from AM-6 to show the existing renderLoadError() ('Couldn't load coupons') state instead of renderUnsupportedSite() when the failure was backend-side.","effort":"M","category":"operability"}
{"id":"AM-8","location":"apps/caramel-extension/shared-utils.js:48-50","quote":"var log = \_isDevInstall()\n ? (...a) => console.log('Caramel:', ...a)\n : () => {}","what":"All log() calls (including the one error-path log for fetchCoupons network exceptions) are compiled to a no-op whenever the extension is installed from a store (update_url present) — i.e. for every real user.","why_it_matters":"Even a technical affected user opening devtools to help support debug gets nothing; combined with AM-6/AM-7, the failure leaves no trace on-device or off-device.","severity":"High","confidence":0.95,"fix_direction":"Keep warn/error-level logs active in production builds (only gate verbose/debug logs on dev), or add a minimal opt-in diagnostic report the user can copy into a support ticket.","effort":"S","category":"operability"}
{"id":"AM-9","location":".github/workflows/checks-app.yml (whole file, and release-extension.yml/checks-extension.yml)","quote":"# workflow names present: checks-app.yml, checks-extension.yml, release-extension.yml — none contains 'deploy', 'dokploy', 'rollback', or 'smoke'","what":"No deploy workflow, post-deploy smoke test, or rollback automation/documentation exists anywhere in the repo; grep for 'dokploy' across all tracked files returns zero hits.","why_it_matters":"Repo alone gives no way to confirm a deploy happened an hour ago, what changed, or how to revert it — the entire rollback story lives outside version control.","severity":"High","confidence":0.9,"fix_direction":"Document the Dokploy deploy trigger/URL and rollback steps in a runbook; add a post-deploy smoke test hitting /api/coupons and /api/health/\*.","effort":"L","category":"operability"}
{"id":"AM-10","location":"apps/caramel-app/src/lib/securityHelpers/apiResponse.ts:1-2","quote":"import { NextApiRequest, NextApiResponse } from 'next'","what":"apiResponse.ts and errorMiddleware.ts are Pages-Router-style helpers with zero imports anywhere in the App-Router-only src tree (no pages/ dir exists) — dead code.","why_it_matters":"No shared error/response convention exists for the router style actually in use, so every route hand-rolls its own catch block (19 distinct console.error sites) with no single place to fix observability once.","severity":"Medium","confidence":0.85,"fix_direction":"Delete the dead Pages-Router helpers; introduce one App-Router error-response helper that all route.ts catch blocks funnel through (also fixes AM-5 in one place).","effort":"M","category":"code_health"}
{"id":"AM-11","location":"apps/caramel-extension/background.js:23,191","quote":"const EXTENSION_API_KEY = 'WXqEpm2uOV5jjJXPpnQFyZiNdaPVUrtd2LIrf4kc1JA'","what":"The extension's API key is hardcoded plaintext in shipped JS, yet the highest-volume call (fetchCoupons → /api/coupons) never sends it, so it never gets the extension rate-limit bypass the server code implies it should.","why_it_matters":"If this well-known-extractable key is ever rotated (e.g. treated as a leaked secret), supported-stores silently 401s for 100% of installs with zero alarm (AM-6 pattern); separately, shared/NAT IPs can rate-limit legitimate extension traffic on the exact endpoint in this incident.","severity":"Medium","confidence":0.65,"fix_direction":"Send x-api-key on the /api/coupons fetch too; document key-rotation blast radius and add a rotation runbook entry.","effort":"S","category":"operability"}
{"id":"AM-12","location":"apps/caramel-app/src/app (no error.tsx or global-error.tsx present)","quote":"(absence confirmed via glob: apps/caramel-app/src/app/**/error.tsx and global-error.tsx both match zero files)","what":"No custom error boundary exists anywhere in the App Router tree, so the one code path that throws uncaught (the per-store SSR page) falls back to Next's default generic error page.","why_it_matters":"Produces a third, inconsistent failure presentation for the same outage (vs. the extension's false-empty-state and the aggregate page's toast), with no branded messaging or built-in Sentry-context enrichment.","severity":"Medium","confidence":0.9,"fix_direction":"Add app/error.tsx and app/global-error.tsx with Sentry.captureException + a branded honest-failure message.","effort":"M","category":"code_health"}
{"id":"AM-13","location":"apps/caramel-app/next.config.mjs:57","quote":"automaticVercelMonitors: true","what":"Sentry's Next.js plugin is configured to auto-create Vercel Cron Monitors, but the app is deployed via Dokploy per the operating context, not Vercel.","why_it_matters":"Suggests the Sentry config was copied from Vercel-oriented setup docs without adaptation to the actual deploy target — a signal that ops config drifts from real infra and shouldn't be trusted at face value during an incident.","severity":"Low","confidence":0.5,"fix_direction":"Confirm actual deploy target and remove/replace automaticVercelMonitors with the correct monitor mechanism for Dokploy-scheduled jobs, if any exist.","effort":"S","category":"code_health"}
{"id":"AM-14","location":"apps/caramel-app/src/app/api/**/route.ts (19 call sites)","quote":"console.error('Error fetching coupons:', error) / console.error('Failed to fetch coupon stats:', error) / console.error('Failed to load store options:', error) [representative sample of 19 sites]","what":"Every API route logs errors as free-text console.error with its own ad hoc message; no structured logging, error codes, or request-correlation ID anywhere in the app.","why_it_matters":"Even with raw log access (Dokploy dashboard), diagnosing this incident means free-text-searching 19 unrelated, differently-worded call sites with no way to correlate a single request across hops.","severity":"Medium","confidence":0.9,"fix_direction":"Adopt one structured logger (JSON, with route/request-id/error-code fields) used consistently across all route handlers.","effort":"M","category":"code_health"}
