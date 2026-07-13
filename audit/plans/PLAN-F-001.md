# PLAN-F-001 — Coupons-DB health probe + typed read boundary + drift check

**Finding:** F-001 (Critical) · externally-owned, health-blind, runtime-untyped coupon catalog · **Effort:** M · **Wave 2 · Sequence position 6** · **Depends-on:** F-004 (vitest infra), F-005 (zod dep + validated env module; already refactored `couponsDb.ts:9-12` env read + documented `COUPONS_DATABASE_URL` in `.env.example`), F-002 (route try/catch → `Sentry.captureException` convention).

## Executive summary

Add a runtime-validated read boundary over `couponsSql` (zod row schema per query, parsed at the boundary, throws loudly on drift → F-002/Sentry), extend the single health endpoint to probe **both** DBs (503 when either is down, monitor-compatible), and ship a dispatch-runnable `information_schema` drift script. ~13 source files touched + tests. **Breaking: N** for the external monitor (HTTP 200/503 + top-level `status` preserved); intentionally fail-loud under active drift. Riskiest step: writing schemas that mirror **postgres.js runtime types** (int4→number vs int8→string, text/`::int`/`COALESCE` nullability) so a healthy DB never false-500s.

## Premise verification (done in code)

- `health/db/route.ts:9-11` probes **only** `prisma.$queryRaw` — coupons DB never checked. **CONFIRMED.**
- Only consumer of `/api/health/db` is an out-of-repo Uptime-Kuma monitor (Bearer `UPKUMA_HEALTH_SECRET`, keys on status code) — no in-repo caller. **CONFIRMED** (grep: var lives only in `health.ts`+`couponsDb.ts`).
- **Premise refined, not broken:** several call sites already pass a TS generic (`couponsSql<Array<{site:string}>>`). That is a **compile-time cast with zero runtime enforcement** — `top-sites` even omits `coupon_count` from its generic while selecting it, proving casts drift silently. Finding's substance (no _runtime_ contract) holds fully.
- Doc note: header calls `couponsDb` "read-only" but two write paths already exist (`coupons/increment`, `coupons/expire` `UPDATE…RETURNING`; `sources` POST `INSERT`). My boundary adds **no** write path and leaves these untouched.

## Scope

**Modify** `src/lib/couponsDb.ts` (add 8 zod row schemas + `parseCouponRows` + `pingCouponsDb`; delete stale unused `CouponRow`). **Modify** `src/app/api/health/db/route.ts`. **Wire `parseCouponRows` into 9 read sites:** `api/coupons/route.ts` (list+count), `api/coupons/stores`, `api/coupons/stats`, `api/coupons/filters` (sites+types), `api/sites/top-sites`, `api/sites/search-supported`, `api/sources` (GET only), `api/extension/supported-stores`, `(marketing)/coupons/[store]/page.tsx` (list+count). **Create** `scripts/check-coupons-schema.ts` + `package.json` script `check:coupons-schema` + `.github/workflows/coupons-schema-drift.yml` (`workflow_dispatch`-only, gated on `COUPONS_DATABASE_URL` secret — never runs on PR/push).
**OUT of scope:** replacing raw SQL with an ORM/second Prisma schema (bigger redesign — rejected); extracting queries into a coupon-domain module (that is **F-006**, position 8 — schemas I add will be _consumed_ by it, not moved now); parsing mutation `RETURNING` rows / any write path; producer-side (Python) shared contract; running the drift check in PR CI; RUNBOOK authoring (F-011 references my probe+script).

## Approach

**Boundary (rejected alt: per-route inline `.parse`).** One home in `couponsDb.ts`: `parseCouponRows<T>(schema, rows, queryLabel): T[]` = `z.array(schema).safeParse`; on failure `throw new Error('coupons-db schema drift ['+label+']: '+issues)`. Each read call site wraps its `await couponsSql\`…\``result. API routes' existing`try/catch`(post-F-002) route the throw to Sentry with the drift label; the SSR page has no try/catch — its throw is captured by the already-wired`onRequestError`(F-002 caveat) and rendered by F-011's`error.tsx`once that lands. **This is the runtime drift detector.** Deliberate trade-off: fail-loud 500/error beats silently-serving-wrong-data for a product whose pitch is honesty.
**8 schemas (1 per distinct row shape):**`CouponListRow`(coupons list +`[store]`page: id, code, site, title, description, rating, discount_type∈PERCENTAGE|CASH|SAVE, discount_amount∈num|null, expiry:str, expired:bool,`timesUsed`, status:str, verificationMessage:str|null — align to `types/coupon.ts:Coupon`, `id`via`z.coerce.string()`to tolerate int4/int8),`TotalCountRow{total}`, `StatsRow{total,expired}`, `SiteRow{site}`(stores/filters/search),`SiteCountRow{site,coupon*count}`(top-sites — fixes the incomplete generic),`DiscountTypeRow{discount_type}`, `SourceRow{id,source,websites:str[],status,total_coupons,total_used,total_expired}`, `StoreConfigRow{store_name + 8 xpath:str|null}`.
**Health (rejected alt: sibling `/api/health/coupons-db`— needs a 2nd monitor target, an ops change; and the finding wants the *existing* green monitor to flip red).** Extend the one route:`Promise.all([timedCheck('auth_db',…prisma), timedCheck('coupons_db',()=>pingCouponsDb())])`; body `{status:ok?'ok':'error', checks:{auth_db, coupons_db}}`; HTTP `200`iff both ok else`503`. Keep top-level `status`so both status-code and keyword monitors survive.
**Drift script:**`tsx scripts/check-coupons-schema.ts`(mirrors existing`scripts/ci-env.ts`), queries `information_schema.columns`for`coupons`/`sources`/`store_verification_configs`/`verification_stores`, asserts every column the 8 schemas read exists, exits non-zero listing missing/renamed columns. Dispatch/manual only (no coupons DB in CI — verified: `ci-env.ts` + workflows never provision it). Satisfies v5 §"schema-drift workflow"; the in-repo zod boundary satisfies v5 §21 \_at runtime* — producer-side shared schema is the **named known-debt remainder** (Python repo out of reach).

## Sequencing (each step ends with its check)

1. **Characterization tests FIRST** (F-004 vitest), mocking `couponsSql`/`prisma` to return representative good rows: pin current success envelope+status of all 9 read routes and the _current single-DB_ health body. → new tests green on unchanged code. **[ckpt A]**
2. Add 8 schemas + `parseCouponRows` + `pingCouponsDb` to `couponsDb.ts`; delete unused `CouponRow`. → `tsc --noEmit` green. **[ckpt B]**
3. Wrap each read query's result in `parseCouponRows(Schema, rows, '<label>')` across the 9 sites. → char tests from step 1 still green (happy path byte-identical). **[ckpt C]**
4. Add schema unit tests (accept prod-shaped fixture, reject drifted/missing-column/wrong-type row) + a route drift test (mocked bad row → 500, not silent). → green. **[ckpt D]**
5. Extend health route to probe both DBs; add health tests (mock each DB up/down → 200 both-ok, 503 either-down, 401 unauth, per-DB body). → green. **[ckpt E]**
6. Add `check-coupons-schema.ts` + npm script + dispatch workflow. → `tsc`, `vitest`, `prettier --check`, `knip` (no orphan exports: all schemas/helpers imported) all green. **Squash → one commit** `fix(F-001): coupons-DB health probe + typed read boundary + schema-drift check`.

## Breaking changes

- **Health body** `{status,service,latencyMs,details}` → `{status,checks:{auth_db,coupons_db}}`. Consumer: external Uptime-Kuma only, keyed on **HTTP code** (200/503) + Bearer. Code contract preserved; top-level `status` retained for keyword monitors. **No in-repo consumer** → zero-tolerance-window needed; note new body in PR + hand to F-011 RUNBOOK.
- **Runtime:** read routes now **throw on drift** (→500 API / error-boundary+Sentry SSR) instead of returning malformed/zeroed data. Only "breaks" under active drift — which today ships silent-wrong. Intended and desired.

## Test strategy

Pinning (before change): 9-route success-envelope characterization + current health body (step 1) — proves happy path unchanged after zod lands. Post-change asserts: (a) each schema accepts a fixture row shaped like production and rejects drifted (missing col / renamed / wrong type / null-where-required); (b) `parseCouponRows` throws with the query label; (c) a route returns 500 (not silent) on a mocked drifted row; (d) health returns per-DB status with 200/503/401 across mocked up/down/unauth. **"Green" =** ckpt A char-green on old code → C char still green → D/E new+negative green → step 6 full toolchain green.

## Rollback

Checkpoints A–E are discrete restartable steps (tests committed first survive a mid-fix restart). Final = one commit; `git revert <sha>` fully restores prior `couponsDb.ts`+health route and drops the script. Boundary is **read-only + additive** → no schema/data change on either DB, revert is instantaneous and cannot corrupt data.

## Risk

**Blast radius:** every coupons read route + SSR store page + the health endpoint. **Worst case:** a schema stricter than reality (nullable-in-prod marked required, or int8 `id` arriving as string) → healthy DB false-500s. **Mitigation:** derive each field's type from _observed postgres.js runtime_ + consuming-code nullability (`::int`/`COALESCE`→non-null; `?? undefined`/`|null`→nullable; `id` coerced), test against real-shaped fixtures, and run `check:coupons-schema` against staging **before merge** as a canary. **Early warning:** char tests red at ckpt C, or the drift script flags a column pre-merge. **Premises:** health-wrong-DB, monitor contract, env/CI absence, runtime-untyped, existing write paths — all **verified in code**; only the exact staging row nullability is **assumed** and is de-risked by the pre-merge canary + fixtures.
