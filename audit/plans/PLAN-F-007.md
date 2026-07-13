# PLAN F-007 — No shared request pipeline (CORS/rate-limit/auth/body re-implemented or skipped per route)

**Finding:** F-007 (High, modularity) · **Effort:** M · **Wave:** 3 · **Seq:** 9 · **Depends-on:** F-004 (vitest `tests/unit/**`, run `pnpm --filter caramel-landing test`), F-002 (`src/lib/api/handleRouteError.ts` — wrapper composes it; F-002 explicitly defers wrapping + body-swallows + oauth bearer swallows to here), F-003 (extension-key semantics + rateLimit exemption), F-006 (coupon domain module — no file overlap), F-009 (withAuth/cors fossils deleted).

## ⚠️ Premise correction (verified in code — read before planning)

The finding + DD3-13 say **"oauth/redirect hand-mints sessions via raw Prisma."** FALSE. `extension/oauth/redirect/route.ts` (113 lines) contains **zero Prisma** — it only forwards the OAuth `code` to the extension redirect URI (chrome-extension:// / \*.chromiumapp.org). The raw User/Account/Session minting is entirely in **`extension/oauth/route.ts`** POST (the code-exchange endpoint): Google branch :209-338, Apple branch :440-581, `prisma.session.create` + `randomBytes(32)` token + 7-day expiry, duplicated across both branches. The fix is unchanged in substance — it targets the correct file. All other premises (no middleware.ts; CORS inlined 3× in authorize :42-44/:62-64/:205-207; oauth-exchange loose-protocol CORS vs authorize exact-allowlist; missing rate limits) confirmed.

## Executive summary

- ONE composable wrapper `src/lib/api/withRoute.ts` + `preflight()` owning CORS · rate-limit · origin-gate · api-key · session-auth · zod-body · auto-OPTIONS · F-002 error boundary — each a declarative field. Migrate all 16 hand-rolled App-Router routes (2 left alone). ~22 files (2 new lib, ~16 routes, ~5 test).
- **Breaking: Y (bounded)** — oauth-exchange CORS tightens loose→exact-allowlist; login/authorize/oauth/suggest GAIN rate-limit; a few missing-field 400→422. Old extensions' happy path unchanged.
- **Riskiest step:** extension/oauth-exchange — centralize the raw-Prisma session mint into one named module. better-auth 1.5.3 has **no public server API** to complete an external code-exchange (only internal `internalAdapter.createSession`) → **STOP-DESIGN triggered** (see §Approach).

## Scope

**Create:** `src/lib/api/withRoute.ts` (wrapper + `preflight`), `src/lib/auth/extensionOAuthSession.ts` (the centralized mint). Tests in `apps/caramel-app/tests/unit/`: `withRoute.test.ts`, `route-pipeline.test.ts` (per-route pins), `extensionOAuthSession.test.ts`.
**Modify (16 routes):** coupons · coupons/filters · coupons/stats · coupons/stores · coupons/increment · coupons/expire · sites/top-sites · sites/search-supported · sites/suggest · sources · classify-cart · extension/supported-stores · extension/login · extension/oauth/authorize · extension/oauth (exchange) · extension/oauth/redirect. Optional new-finding hook: `src/lib/api/apiKey.ts` if F-003 left no shared key helper.
**OUT of scope:** `auth/[...all]/route.ts` (better-auth `toNextJsHandler` — never wrap) · `health/db` (monitoring; keeps own `authorize()` + no rate-limit — documented exemption) · a real Next `middleware.ts` (Next 16 App-Router has no per-route middleware seam for these concerns — the wrapper IS the mechanism; rejected in F-002 too) · changing rateLimit.ts internals / F-003 key model · the `/api/auth/session`→`get-session` path bug + no-emailVerified-gate in the mint (pin as-is; **park NEW finding**) · coupon SQL/domain (F-006) · success-envelope unification beyond error path.

## Approach (alternatives rejected)

- **Per-handler wrapper, not a route-module factory.** `export const POST = withRoute({method:'POST',cors,rateLimit,origin,apiKey,auth,body,routeName}, async ({req,body,session})=>…)`; `export const OPTIONS = preflight({cors,methods})`. Keeps App-Router named exports familiar for the cold executor. Rejected `defineRoute({GET,POST})` builder — larger churn to every file's export shape.
- **Concern order (early-return each):** compute CORS headers → origin-gate 403 → apiKey 401 → auth 401 → rateLimit 429 → body safeParse 422 → handler in try/catch → `handleRouteError`. **Merge CORS headers onto EVERY returned Response (incl. 4xx/429/500) when cors≠'none'** — matches today's authorize/oauth attaching corsHeaders to their 400s (else a preflight-passing extension can't read the error).
- **CORS `extension` = exact env-allowlist** (`CHROME/FIREFOX/SAFARI_EXTENSION_ORIGIN`, reflect matching Origin) — authorize's stricter model. This UNIFIES the 5 origin checks and TIGHTENS oauth-exchange (was any `chrome-extension://…` prefix). Safe because the published extension's origin must already be in that allowlist for authorize (which it calls first) to work today. `public`/`none` also offered; every current non-oauth route = `none` (they set no CORS today — extension calls them from its privileged background, not a CORS context).
- **Body = per-route zod encoding the route's REAL contract.** Strict where the field is truly required (suggest/login/oauth → 422); lenient (`.optional().default()`) where today's handler tolerates `{}` (expire→{count:0}, increment→query-first, sources→400, search-supported→{sites:[]}) so their output is byte-identical. One mechanism, contract per schema — not two ways. classify-cart keeps its `sanitize()` (already validated-or-400, not a swallow) with `body:null`.
- **auth:'session'** = `auth.api.getSession({headers:req.headers})`→401 if null (better-auth direct — NOT the deleted withAuth API). Implemented + unit-tested; applied to **zero** current routes (none need it) — satisfies "one way to require a session," ready, exercised by tests (not dead).
- **Session mint — STOP-DESIGN (primary).** Extract both branches' user/account/session mint + bearer self-fetch into ONE `mintExtensionSession({provider,providerUser,tokens})→{token,username,image}` with a loud header comment (why it bypasses better-auth; delete-when-public-API-exists). Kills the 2-branch duplication = the finding's actual defect ("two implementations that can diverge"). **Park NEW finding** to later route through better-auth. _Rejected as default:_ `auth.$context.internalAdapter.createSession` — it exists (admin impersonate uses it) but is INTERNAL/version-unstable; changes the token shape → security-surface risk on a High-modularity fix. **Trigger to adopt it instead:** executor confirms internalAdapter stable in 1.5.3 AND a characterization test proves the new token authenticates via `/api/auth/get-session`+bearer identically → else centralize-only.

## Route coverage audit (current → target; the table IS the audit)

| Route                                               | Method   | CORS                     | RateLimit                | Origin         | ApiKey                         | Body→schema                                                      |
| --------------------------------------------------- | -------- | ------------------------ | ------------------------ | -------------- | ------------------------------ | ---------------------------------------------------------------- |
| coupons, /filters, /stats, /stores, sites/top-sites | GET      | none                     | read (keep)              | —              | —                              | —                                                                |
| sites/search-supported                              | POST     | none                     | read (keep)              | —              | —                              | lenient(query?)                                                  |
| coupons/increment                                   | POST     | none                     | mutation                 | yes            | —                              | lenient(id? query-first)                                         |
| coupons/expire                                      | POST     | none                     | mutation                 | yes            | **extension-key** (post-F-003) | lenient(ids?→{count:0})                                          |
| sources                                             | GET/POST | none                     | read/mutation            | POST yes       | —                              | POST strict(website)→422                                         |
| classify-cart                                       | POST     | none                     | mutation                 | yes            | —                              | keep sanitize() (body:null)                                      |
| sites/suggest                                       | POST     | none                     | **+mutation (NEW)**      | **+yes (NEW)** | —                              | strict(url) 400→422                                              |
| extension/supported-stores                          | GET      | none                     | exempt(key)              | —              | **key**→wrapper (post-F-003)   | —                                                                |
| extension/login                                     | POST     | none                     | **+mutation (NEW)**      | —              | —                              | strict(email,password) 400→422                                   |
| extension/oauth/authorize                           | GET+OPT  | **extension** (3×→0)     | **+mutation (NEW)**      | —              | —                              | — (auto OPTIONS)                                                 |
| extension/oauth (exchange)                          | POST+OPT | **extension (TIGHTEN)**  | **+mutation (NEW)**      | —              | —                              | strict(provider,code,state,redirectUri) 400→422; **mint→module** |
| extension/oauth/redirect                            | GET+POST | none                     | none (provider callback) | —              | —                              | keep formData/query                                              |
| health/db                                           | GET      | none                     | **none (KEEP)**          | —              | authorize() keep               | —                                                                |
| auth/[...all]                                       | ALL      | LEAVE — better-auth owns |                          |                |                                |                                                                  |

Rulings for gaps: `health/db` + `redirect` stay unthrottled (monitoring / OAuth-provider server-to-server callback — throttling Google/Apple is wrong). All other prior gaps (authorize/oauth/login/suggest) GET a mutation limit.

## Sequencing (each ends with its check; F-004 suite green throughout)

1. **Wrapper + unit tests** (`withRoute.ts`,`preflight`; `apiKey.ts` if needed). Check: `withRoute.test.ts` green — each concern toggles independently.
2. **Batch A read-only** (coupons×4, top-sites, search-supported): wrap. Check: per-route pins — 200 + envelope + `X-RateLimit-*` unchanged.
3. **Batch B mutations non-auth** (increment, expire, sources, classify-cart, suggest, supported-stores): wrap incl. origin/apiKey/body. Check: pins — happy identical; lenient-body `{}` byte-identical; suggest 422; +rl headers present.
4. **Batch C auth/oauth LAST** — 4a pins FIRST capturing exact oauth-exchange output (`token`=current value incl. raw-sessionToken fallback, `username`/`image` fallbacks, reflected-Origin CORS, each 400). 4b extract `mintExtensionSession`; both branches call it (behavior-neutral, pins green). 4c wrap login(+rl)/authorize(CORS dedup+auto-OPTIONS+rl)/redirect(error-boundary)/oauth-exchange(CORS tighten+rl+body). Check: oauth pins green + `tsc` + **manual Stealth extension-login on dev.grabcaramel.com** (e2e can't cover this — see §Tests).
5. **Squash → one commit** `fix(F-007): shared route pipeline (withRoute) + centralized extension OAuth session`. Check: full suite + `pnpm -r type-check` green.

## Breaking changes

- **CORS tighten (oauth-exchange):** loose `chrome-extension://*` → exact env-allowlist. Consumer = published extension; its origin already required by authorize → **pre-ship gate: verify prod `CHROME/FIREFOX/SAFARI_EXTENSION_ORIGIN` list the shipped extension IDs** (add if missing). Tolerance: none — must be correct at deploy.
- **New rate limits** (login/authorize/oauth/suggest): mutation 30/min/IP + burst 20/2s. Human login/suggest nowhere near; extension login = 2 calls. Shared-NAT risk minimal.
- **400→422** on suggest/login/oauth missing fields; expire/increment/sources/search-supported PRESERVED. Consumers check `resp.ok`, not exact 4xx (verified: extension + web UI). OPTIONS standardized (204 + reflected origin) — read routes gain no OPTIONS.
- **Mint centralization:** wire-identical (pinned). If internalAdapter path is taken instead, token shape changes → gated behind char-test equivalence (defaults off).

## Test strategy (F-004 infra; pins BEFORE change)

- **`withRoute.test.ts`:** each concern isolated — cors:extension reflects known / omits unknown Origin; preflight→204+`Allow-Methods`; rateLimit delegates (mock checkRateLimit→429 passes through, CORS merged); origin:true→403; apiKey mismatch→401; auth:session null→401 (mock `@/lib/auth/auth`); body invalid→422 / valid→typed; handler throw→`handleRouteError` (mock Sentry: `{error}`+500+`x-request-id`).
- **`route-pipeline.test.ts`:** F-004 pattern (`vi.mock('@/lib/couponsDb')` recording tag, `vi.mock('@/lib/rateLimit')`, `vi.mock('@/lib/prisma')`) — pin status+headers+envelope on happy+error for each migrated route BEFORE wrapping, re-run AFTER. oauth-exchange: mock prisma+`fetch`, pin `{token,username,image}` + CORS + 400s **exactly**.
- **`extensionOAuthSession.test.ts`:** google+apple → identical session/token output the pre-refactor route produced.
- **e2e:** existing `auth.spec.ts`/`auth-flows.spec.ts` are **fully UI-mocked** (intercept `/api/auth/*`) and never hit `/api/extension/oauth` — they stay green but are **NOT** the safety net for Batch C. Net = the oauth pins + a manual Stealth extension login (Google) against dev. "Green" = wrapper tests (1); per-batch pins (2-4); full suite + type-check (5).

## Rollback

One commit; internal checkpoints = batches 1-4, pins written first persist across a failed-step restart (`git checkout -- <route>`). Revert = drop `fix(F-007)`; wrapper + mint module are additive, per-route edits mechanical; no schema/data/deploy touched.

## Risk

Blast radius = every API route. Worst case: wrapper drops a header/status, or CORS tighten locks out the live extension. Early warning: per-route pins assert exact status/headers/envelope; oauth pins assert token+CORS; post-deploy extension-login failure = CORS/env-origin mis-set, 429 on login = rl too tight. **Premises: verified-in-code** (no middleware.ts; CORS 3× in authorize; loose-vs-exact CORS split; 5 origin impls; missing limits; mint duplicated across 2 branches; better-auth 1.5.3 has no public external-code-exchange API) — **except the one flagged at top** (mint is in oauth/route.ts, not redirect). **Assumed:** F-003 leaves a callable extension-key check (fallback: F-007 extracts it into `apiKey.ts`); shipped extension IDs are in the prod origin allowlist (pre-ship gate).
