# Caramel Pre-Mortem — written as a postmortem from Jan 2027

Repo state audited: `dev` @ `537547b3081aa3a0ec817cdc5f6dac4f0d328dbb`. Read-only pass.
Priorities: maintainability, operability. Security architecture treated as accepted (findings below are framed as availability/contract/cost, not "is this secret safe").

---

## 1. The postmortem narrative

### What the quarter looked like (Q4 2026 → Jan 2027)

**The outage.** On a Tuesday the Python verification team — who own the `caramel_coupons` database that Next.js reads directly — shipped a routine migration to their own repo: they renamed `coupons.verification_message` and folded three coupon `status` values into a new one. They had no reason to think this would touch the web app; the web app is a different repo and the column rename was internal to their service. Within minutes every coupon surface on grabcaramel.com and every extension `fetchCoupons`/`fetchSupportedStores` call started returning `{ "coupons": [] }` and HTTP 500s. The Next.js app talks to that database through hand-written template-string SQL (`couponsSql`) with **no generated types, no schema, and no shared contract** (`apps/caramel-app/src/lib/couponsDb.ts`), so nothing caught the drift at build time — `pnpm tsc --noEmit` is green because the columns live in string literals.

The outage was not just likely; it was **invisible**. `/api/health/db` only runs `prisma.$queryRaw SELECT 1` against the _auth_ Postgres, which was perfectly healthy, so Uptime Kuma stayed green the entire time. Every coupon route `catch`es its error and returns a 500 after a `console.error` — and because the handlers catch, Next's `onRequestError` → `Sentry.captureRequestError` hook never fires and there is no `Sentry.captureException` in any catch block. So Sentry was silent too. The team found out from Discord and support tickets ~40 minutes in, then spent the incident reverse-engineering which of a dozen untyped SQL literals referenced the renamed column, because the app has no map of what it reads from the database it doesn't own. `.env.example` doesn't even list `COUPONS_DATABASE_URL`, so the newest on-call engineer initially didn't know the second database existed.

To make it worse, that same week a well-meaning infra change put the app behind a second replica for a marketing push. The rate limiter is an in-memory token bucket (`apps/caramel-app/src/lib/rateLimit.ts`) that `getClientIp` collapses to a single `'unknown'` bucket whenever `x-real-ip`/`x-forwarded-for` aren't set the way it expects — so a proxy tweak briefly funneled all traffic into one 120-req/min global cap and 429'd real users, and the classify-cart LLM cache (per-instance `Map`) halved its hit rate and doubled OpenRouter spend.

**The missed deadline.** The same quarter, the team committed to "auto-apply live on our top 40 stores across all browsers by end of quarter." It slipped badly, and the reasons are all structural. Adding a store or a coupon `status` means editing raw SQL string literals in four-plus routes that already disagree with each other (`coupons/route.ts` surfaces seven statuses; `stats`/`filters` only `'valid'`), with no compiler help and no single source of truth. Worse, the extension ships **three divergent manifests** — `manifest.json` (v1.1.0, matches `https://*/*`), `manifest-firefox.json` (v1.0.5, matches only amazon/ebay/codecademy and references an `amazon.js` file that does not exist in the repo), and `package.json` (v1.0.2) — so "ship it to all browsers" meant hand-reconciling files that had silently drifted for months, and the Firefox build only ever injected on three hard-coded domains regardless of what the store-config API served. The release workflow has no version-bump step, so two attempted Chrome uploads were rejected for duplicate version numbers before someone remembered to hand-edit the manifest. And every deploy required a human to remember to run `prisma migrate deploy` by hand (it is in no build/start script and no deploy config), which everyone was afraid to do during a feature crunch. The "40 stores everywhere" epic died by a thousand manual, drift-prone paper cuts — the same class of problem that caused the outage, viewed from the maintainer's chair instead of the pager's.

### The one-line thesis

The product's core data lives in a database this repo does not own, is read through untyped string SQL, and has **neither a health check nor error capture** — so any drift or outage in it is simultaneously easy to cause, invisible to monitoring, and expensive to change. Every other finding is a variation on "two representations of one thing that are allowed to drift."

---

## 2. CAUSAL FINDINGS

```json
[
    {
        "id": "PM-1",
        "location": "apps/caramel-app/src/lib/couponsDb.ts:1",
        "quote": "// Read-only connection to the `caramel_coupons` database owned by the\n// Python verification service. All mutations to the coupon catalog flow\n// through that service — Next.js only reads (plus two narrow mutations:\n// usage-increment and expire, both exposed to the extension).\nimport postgres from 'postgres'\n\nconst connectionString = process.env.COUPONS_DATABASE_URL",
        "what": "The entire coupon catalog + store xpath configs (the product's core data) live in an externally-owned Postgres DB, read via hand-written template-string SQL against tables (coupons, store_verification_configs, verification_stores) that have no schema, no generated types, and no migration/versioning inside this repo. tsc cannot see column names embedded in SQL strings.",
        "why_it_matters": "A column rename, type change, or status-value change in the other team's repo silently breaks every coupon endpoint at runtime with zero build-time warning. The schema-drift CI job only guards the Prisma/auth DB; the coupons DB has zero contract coverage. This is the single largest maintainability + operability liability.",
        "severity": "Critical",
        "confidence": 0.95,
        "fix_direction": "Introduce a versioned contract for the coupons DB: a typed data-access layer (generated types or a checked-in view/DTO the Python team must not break), contract tests run in CI against a seeded coupons schema, and an ADR pinning the column/status vocabulary as a cross-repo interface.",
        "effort": "L",
        "category": "architecture"
    },
    {
        "id": "PM-2",
        "location": "apps/caramel-app/src/app/api/health/db/route.ts:9",
        "quote": "const result = await timedCheck('database', async () => {\n        await prisma.$queryRaw`SELECT 1`\n    })\n\n    return NextResponse.json(result, {\n        status: result.status === 'ok' ? 200 : 503,\n    })",
        "what": "The only DB health check probes the Prisma/auth database. There is no readiness probe for the coupons DB (couponsSql / COUPONS_DATABASE_URL). Meanwhile every coupon route catches its error and returns a 500 after console.error, and Sentry is wired only via Next's onRequestError (instrumentation.ts:12 `export const onRequestError = Sentry.captureRequestError`) which never fires for a caught error — no catch block calls Sentry.captureException.",
        "why_it_matters": "A coupons-DB outage or drift takes down 100% of coupon functionality while /api/health/db returns 200 (Uptime Kuma green) and Sentry records nothing. The incident is only discoverable via user complaints, guaranteeing a long time-to-detect. This is what turns PM-1's likely failure into a prolonged, invisible one.",
        "severity": "Critical",
        "confidence": 0.85,
        "fix_direction": "Add a coupons-DB health check (SELECT 1 over couponsSql) to the readiness endpoint; add Sentry.captureException (or rethrow) in coupon-route catch blocks so 5xx from the coupons DB page someone. Alert on coupon-route 5xx rate.",
        "effort": "S",
        "category": "operability"
    },
    {
        "id": "PM-3",
        "location": "apps/caramel-extension/background.js:11",
        "quote": "const _isDevInstall = () => {\n    try {\n        return !currentBrowser.runtime.getManifest().update_url\n    } catch (_) {\n        return false\n    }\n}\nglobalThis.CARAMEL_BASE_URL = _isDevInstall()\n    ? 'https://dev.grabcaramel.com'\n    : 'https://grabcaramel.com'",
        "what": "The dev-vs-prod backend switch (and the postMessage trusted-origins list in shared-utils.js) keys entirely on the presence of `update_url` in the manifest. Only Chrome Web Store packed builds get an injected update_url. Safari builds produced by `safari-web-extension-converter` (release-extension.yml) and Firefox/AMO builds do not carry update_url, so `_isDevInstall()` returns true for real production installs on those browsers.",
        "why_it_matters": "Production Safari/iOS and Firefox users are routed to the DEV backend (dev.grabcaramel.com) and their extension additionally trusts localhost/dev origins. The blast radius is the entire Safari+iOS+Firefox install base, and because store review takes weeks, a bad build cannot be rolled back quickly. The top commit just repointed dev installs from localhost to dev.grabcaramel.com, freshly activating this path.",
        "severity": "Critical",
        "confidence": 0.75,
        "fix_direction": "Do not infer environment from update_url. Bake the target backend into a build-time constant per store target (separate build outputs for Chrome/Firefox/Safari/dev), or gate dev behavior behind an explicit build flag rather than a browser-specific manifest artifact.",
        "effort": "M",
        "category": "operability"
    },
    {
        "id": "PM-4",
        "location": "apps/caramel-app/src/app/api/coupons/route.ts:47",
        "quote": "couponsSql`status IN ('valid','valid_with_warning','product_restriction','category_restricted','seller_specific','pending','retry') AND expired = FALSE`,",
        "what": "The 'which coupon statuses are user-visible' business rule is copy-pasted as a raw-SQL string literal across coupons/route.ts and coupons/stores/route.ts (the 7-status list, twice), while stats/route.ts and filters/route.ts use `status = 'valid'` only, and types/coupon.ts defines a 9-value enum. Four+ representations of one vocabulary, already inconsistent.",
        "why_it_matters": "The list and the filter dropdown already disagree (a store can appear in results but not in the filter). Adding or renaming a status — which the externally-owned service can do at any time — is a multi-file scavenger hunt across untyped strings with no compiler or test to catch a miss. Direct feature-velocity drag and a latent correctness bug.",
        "severity": "High",
        "confidence": 0.9,
        "fix_direction": "Define the visible-status set once (a typed constant / shared SQL fragment) and reference it from every query; add a test asserting list, stats, and filters use the same predicate.",
        "effort": "S",
        "category": "duplication"
    },
    {
        "id": "PM-5",
        "location": "apps/caramel-extension/manifest-firefox.json:3",
        "quote": "\"version\": \"1.0.5\",\n...\n    \"content_scripts\": [\n        {\n            \"matches\": [\n                \"https://www.amazon.com/*\",\n                \"https://*.ebay.com/*\",\n                \"https://*.codecademy.com/*\"\n            ],\n            \"js\": [\"shared-utils.js\", \"UI-helpers.js\", \"inject.js\", \"amazon.js\"]",
        "what": "Three versions for one extension (manifest.json 1.1.0, manifest-firefox.json 1.0.5, package.json 1.0.2). The Firefox manifest is hand-maintained and structurally divergent: it matches only 3 hard-coded stores (vs `https://*/*` in Chrome), requests different permissions (adds management/alarms), uses a background `scripts` array instead of a service worker, and lists `amazon.js` in content_scripts — a file that does not exist in the repo.",
        "why_it_matters": "Firefox users get a stale, mostly-broken product where the dynamic supported-stores API is defeated by a 3-domain content-script match, and the missing amazon.js can break injection on the domains it does target. Shipping any new supported store 'everywhere' requires reconciling divergent hand-edited manifests — a core reason the cross-browser rollout slips.",
        "severity": "High",
        "confidence": 0.85,
        "fix_direction": "Generate per-browser manifests from one source of truth with a single version field; remove dead file references; drive content-script matches from the same store list the API serves. Add a CI check that every manifest content-script file exists.",
        "effort": "M",
        "category": "modularity"
    },
    {
        "id": "PM-6",
        "location": "apps/caramel-app/src/lib/rateLimit.ts:6",
        "quote": "// Per-IP rate limiting for public API routes. In-memory token buckets —\n// sufficient for single-instance dev + prod. Swap to\n// `RateLimiterRedis` (same API) when we scale to multiple instances.",
        "what": "Rate limiting and the classify-cart LLM cache are both in-memory and per-instance. getClientIp falls back to a literal `return 'unknown'` when x-real-ip/x-forwarded-for are absent, so all such traffic shares one bucket. A Redis service already exists in local-dev compose but is unused by the limiter.",
        "why_it_matters": "The moment the app runs more than one replica (or during a rolling deploy), limits and the LLM cost cache silently degrade. If the reverse proxy doesn't set the expected IP headers, every request collapses into the single 'unknown' bucket and the whole API is throttled to 120/min globally — a self-inflicted outage triggered by an infra change, not a code change.",
        "severity": "High",
        "confidence": 0.8,
        "fix_direction": "Move rate limiting + classify cache to Redis (already provisioned). Fail closed-or-explicit on missing client IP rather than a shared 'unknown' bucket; verify the Dokploy/Traefik proxy forwards x-real-ip.",
        "effort": "M",
        "category": "operability"
    },
    {
        "id": "PM-7",
        "location": "apps/caramel-app/nixpacks.toml:6",
        "quote": "[phases.install]\ncmds = [\"pnpm install --no-frozen-lockfile\"]\n\n[phases.build]\ncmds = [\"pnpm run build\"]\n\n[start]\ncmd = \"pnpm run start\"",
        "what": "The deploy path (nixpacks: install → build → start; app build = `prisma generate && next build`; start = `next start`) contains no `prisma migrate deploy`. Migrations are applied only by the CI schema-drift job against an ephemeral Postgres, never against prod. Applying prod migrations is a manual `pnpm db:migrate:deploy` that lives in no runbook.",
        "why_it_matters": "A deploy that includes a schema change but where nobody remembers to migrate prod boots the app against an old schema — auth queries fail and the site goes down, with no automation or documentation to prevent it. During a feature crunch this is exactly when it gets forgotten.",
        "severity": "High",
        "confidence": 0.85,
        "fix_direction": "Add `prisma migrate deploy` as a release/start-gate step (idempotent) or a documented, enforced deploy hook; make it impossible to ship code without the matching migration.",
        "effort": "S",
        "category": "operability"
    },
    {
        "id": "PM-8",
        "location": "apps/caramel-app/.env.example:1",
        "quote": "# Database\nDATABASE_URL=\"postgresql://postgres:postgres@localhost:2345/caramel\"\n...\n# useSend Email\nUSESEND_API_KEY=\n...\n# OpenRouter (extension cart classifier)\nOPENROUTER_API_KEY=",
        "what": ".env.example omits multiple env vars the code hard-requires: COUPONS_DATABASE_URL (couponsDb.ts throws on import if unset), EXTENSION_API_KEY, EXTENSION_OAUTH_STATE_SECRET, ALLOWED_ORIGINS, UPKUMA_HEALTH_SECRET. It also contradicts itself operationally: it documents USESEND_* (which email.ts actually reads) while scripts/ci-env.ts writes SMTP_HOST/USER/PASSWORD that no code reads, and its DB port (2345) matches neither local-dev (58005) nor BETTER_AUTH_URL's port (3000 vs app PORT 58000).",
        "why_it_matters": "The environment contract is undocumented and internally inconsistent, so a new engineer or AI agent cannot boot the product's coupon features from the docs, and a prod deploy missing COUPONS_DATABASE_URL crashes coupon routes on first import while auth (and the health check) stay green. No zod/env validation centralizes the real surface.",
        "severity": "High",
        "confidence": 0.9,
        "fix_direction": "Introduce validated env parsing (zod) as the single source of truth; regenerate .env.example from it; reconcile ci-env.ts to the real vars (USESEND_*, COUPONS_DATABASE_URL, etc.).",
        "effort": "S",
        "category": "docs"
    },
    {
        "id": "PM-9",
        "location": "apps/caramel-app/nixpacks.toml:7",
        "quote": "cmds = [\"pnpm install --no-frozen-lockfile\"]",
        "what": "Production builds install with --no-frozen-lockfile, while all four CI jobs install with --frozen-lockfile. Prod can therefore resolve different (newer) transitive dependency versions than CI ever tested.",
        "why_it_matters": "Non-reproducible prod builds: 'green in CI, broken in prod' and 'worked yesterday, broke today with no code change' become possible whenever an upstream dependency publishes. Undermines the whole point of a committed lockfile and makes incident bisection unreliable.",
        "severity": "Medium",
        "confidence": 0.85,
        "fix_direction": "Use --frozen-lockfile in the deploy install; make lockfile updates an explicit, reviewed change.",
        "effort": "S",
        "category": "dependencies"
    },
    {
        "id": "PM-10",
        "location": ".github/workflows/release-extension.yml:1",
        "quote": "      - name: Build extension\n        run: pnpm run build\n\n      - name: Package extension\n        run: pnpm run package\n...\n      - name: Upload to Chrome Web Store (upload-only)\n        uses: mnao305/chrome-extension-upload@v5.0.0\n        with:\n          file-path: extension.zip\n          publish: false",
        "what": "The release workflow builds, packages, and uploads to the stores with no version-bump step. The version shipped is whatever a human last hand-edited into manifest.json — which already disagrees with manifest-firefox.json and package.json (PM-5). Firefox has no publish job here at all.",
        "why_it_matters": "Chrome and Apple reject uploads whose version isn't strictly greater than the live one, so a merge to main without a manual bump fails the release at the worst possible moment. Release is gated on human memory, and the observed 3-way version drift is direct evidence the manual bump is unreliable.",
        "severity": "Medium",
        "confidence": 0.8,
        "fix_direction": "Automate a single version bump across all manifests on release (or derive all manifests + package.json from one version source); add Firefox to the release automation.",
        "effort": "M",
        "category": "operability"
    },
    {
        "id": "PM-11",
        "location": "apps/caramel-app/src/lib/rateLimit.ts:160",
        "quote": "export function isOriginAllowed(req: NextRequest): boolean {\n    const origin = req.headers.get('origin')\n    if (!origin) return true",
        "what": "The classify-cart endpoint (a paid OpenRouter LLM call) is gated only by isOriginAllowed + a 30/min per-IP mutation limit and an in-memory cache. isOriginAllowed returns true whenever there is no Origin header, so any server-side/scripted caller with no Origin passes the gate; only per-IP rate limiting and the per-instance cache bound spend. No API key is required (unlike supported-stores/expire).",
        "why_it_matters": "Uncontrolled third-party LLM cost exposure and a hard runtime dependency on OpenRouter for the 'relevant coupons' feature, with no server-side budget guard. Per-instance cache (PM-6) means cost also scales with replica count and cold starts. Framed as cost/operability, not access-control.",
        "severity": "Medium",
        "confidence": 0.7,
        "fix_direction": "Require the extension API key on classify-cart, add a global spend cap/circuit-breaker around openrouter, and move the cache to shared Redis so cost is bounded independent of instance count.",
        "effort": "M",
        "category": "operability"
    },
    {
        "id": "PM-12",
        "location": "apps/caramel-extension/background.js:1",
        "quote": "const { site, kw, category } = message\n            const url = new URL(caramelUrl('api/coupons'))\n            url.searchParams.set('site', site)\n            url.searchParams.set('key_words', kw || '')\n            url.searchParams.set('limit', '20')\n            if (category) url.searchParams.set('category', category)",
        "what": "The shipped extension sends a `category` query param to /api/coupons, but the route parses only site/page/limit/search/type/key_words — `category` is silently ignored. The classify-cart result the extension pays an LLM for is dropped on the floor server-side.",
        "why_it_matters": "A live contract mismatch between a client that lives for weeks and an API that deploys continuously, with nothing (no shared types, no contract test) to flag it. Today it's a dead param and a wasted classification; the same invisible gap is how a real client/API break ships unnoticed.",
        "severity": "Low",
        "confidence": 0.8,
        "fix_direction": "Either implement category filtering server-side or remove it client-side; add a contract test covering the extension's exact /api/coupons request shape.",
        "effort": "S",
        "category": "clarity"
    },
    {
        "id": "PM-13",
        "location": "apps/caramel-extension/background.js:27",
        "quote": "const EXTENSION_API_KEY = 'WXqEpm2uOV5jjJXPpnQFyZiNdaPVUrtd2LIrf4kc1JA'",
        "what": "A single shared EXTENSION_API_KEY value is baked into every shipped client and validated server-side by supported-stores and expire (and used for extension detection in rateLimit). Not auditing whether embedding a secret is acceptable — the operability trap is that it is one value shared by all clients that cannot be rotated without simultaneously invalidating every extension already in the field.",
        "why_it_matters": "If the server ever rotates this key (leak, policy, incident response), every shipped extension immediately 401s on supported-stores → store xpath configs stop loading → auto-apply breaks for the entire install base until users receive an updated build, which is weeks away through store review. A recovery action that should take minutes takes weeks.",
        "severity": "High",
        "confidence": 0.7,
        "fix_direction": "Support key versioning / overlap (accept old+new during a rotation window), or move extension auth to a rotatable per-client/short-lived token so the server can rotate without bricking fielded clients.",
        "effort": "M",
        "category": "operability"
    }
]
```

---

## 3. Discard list (claims that failed my own quote test)

- **"`pnpm doctor` in checks-app.yml is a broken/no-op CI step."** DISCARDED — `pnpm doctor` is a real pnpm command ("Checks for known common issues", verified via `pnpm doctor --help`), so the "Validate dependencies" step is valid, if shallow. No defect.
- **Hardcoded EXTENSION*API_KEY / base URLs as a \_security* finding.** DISCARDED as security (out of scope per brief). Kept only the operability/rotation-coupling angle as PM-13.
- **Better-auth cookie SameSite/Secure and OAuth state-signing logic.** DISCARDED — this is auth/security architecture, explicitly accepted; the code (HMAC-signed state, timingSafeEqual, secure-cookie derivation) is deliberate and not a maintainability/operability defect.
- **"Coupons DB exposes mutations (increment/expire) from a 'read-only' client — inconsistency."** DISCARDED — couponsDb.ts explicitly scopes the two mutations and they are intentional; no drift/defect, just naming.
- **"In-memory classify-cart cache is unbounded."** DISCARDED — it is explicitly capped (CACHE_MAX 2000, 24h TTL) with LRU eviction; the real issue (per-instance, not shared) is captured under PM-6/PM-11, so no separate finding.
- **`ci-env.ts` writing SMTP\_\* that no code reads, as a standalone finding.** DISCARDED as standalone — folded into PM-8 as evidence of an unreconciled env surface rather than double-counted.
