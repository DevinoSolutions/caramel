# PLAN-F-006 — Coupon domain logic/constants have no single home

**Finding:** F-006 (High, duplication) · **Effort:** M · **Wave:** 3 · **Seq:** 8 (first of Wave 3)
**Depends-on:** F-004 (vitest infra — pins/sync/ban tests run here), F-005 (env module — `COUPONS_DATABASE_URL` now validated; `couponsSql` import unchanged), F-009 (knip ignore cleaned — new files must be referenced so knip stays honest). Builds on F-001/F-002 (landed, orthogonal — I touch WHERE-composition + constants, not the catch blocks or row-typing).

## Executive summary

Create ONE pure coupon-domain module (status vocabulary + label/tier meta + visibility/restricted predicates), add server-only SQL fragments to `couponsDb.ts`, and codegen a committed `coupon-constants.generated.js` the extension loads via `window.CaramelCoupons`. ~7 files modified, ~4 created. **Breaking: N** to consumers; **one deliberate behavior change** (coupons/filters broadens `valid`→visible — flagged). Riskiest step: the extension load-order wiring (content-script + popup) — mitigated by reusing the existing `window.Caramel*` convention. Premises verified in code (9 status sites enumerated below); no re-scope.

## Scope

**Create:** `apps/caramel-app/src/lib/coupons.ts` (PURE domain: `STATUS_TABLE as const` → `CouponStatus`, `COUPON_STATUSES`, `VISIBLE_COUPON_STATUSES`, `RESTRICTED_COUPON_STATUSES`, `isVisibleStatus`/`isRestrictedStatus`, `STATUS_META{label,tier}`; NO server imports); `apps/caramel-app/scripts/generate-coupon-constants.ts` (tsx; exports `renderCouponConstants(): string`, writes the ext file); `apps/caramel-extension/coupon-constants.generated.js` (committed; sets `window.CaramelCoupons`); F-004 tests (below).
**Modify (app):** `couponsDb.ts` (add server SQL fragments `visibleCouponsWhere()`, `rankingOrderSql()`, `verifiedCensusSql()`); `api/coupons/route.ts:48,99`; `(marketing)/coupons/[store]/page.tsx:47,55,62,57`; `api/sites/top-sites/route.ts:13`; `api/sites/search-supported/route.ts:24`; `api/coupons/stores/route.ts:18,25`; `api/coupons/filters/route.ts:20,28`; `api/coupons/stats/route.ts:15`; `components/coupons/coupon-card.tsx:15-34`; `types/coupon.ts:1-10` (re-export `CouponStatus` from `@/lib/coupons`); `package.json` (+`generate:coupon-constants` script).
**Modify (ext):** `shared-utils.js:1054-1059`; `popup.js:604-609,638-664`; `manifest.json:39-44` + `manifest-firefox.json` (prepend generated file to `content_scripts.js`); `index.html:61` (script tag before shared-utils.js); `.prettierignore` (+generated file; create if absent) and eslint ignore.
**OUT of scope:** jscpd .tsx marketing/auth clones (separate concern, next cycle); F-007 route-pipeline; F-008 shared-utils split; F-013 `any` on decrypt; renaming `caramel-landing` (F-015). No new coupon behaviors beyond the one filters ruling.

## Approach

- **SoT = the TS module** (`coupons.ts`), not JSON: `tsx` is present (mirrors `scripts/ci-env.ts`), `as const` yields the literal `CouponStatus` union for free, and a **pure** module is importable by the `'use client'` `coupon-card.tsx` AND by codegen. _Rejected JSON SoT:_ resolveJsonModule widens to `string` (no literal union) and adds a file for no gain.
- **Client/server split is mandatory:** `coupon-card.tsx` is `'use client'`; if it imported the `postgres`-backed `couponsSql`, the client bundle breaks. So constants/types/meta live in pure `coupons.ts`; SQL fragments live in server-only `couponsDb.ts` (already the DB home) which imports `VISIBLE_COUPON_STATUSES` from `coupons.ts` (no cycle). _Rejected:_ one big module (poisons client bundle).
- **SQL fragment = factory** `() => couponsSql\`status IN ${couponsSql([...VISIBLE_COUPON_STATUSES])} AND expired = FALSE\``. Composable (proven: marketing page reuses a `couponsSql`fragment across 2 queries) and parameterized via`sql(array)`(idiomatic postgres.js; statuses are constants → no injection; behavior-identical to inline literals). Factory (not module-const) sidesteps any fragment-reuse doubt. Ranking →`() => couponsSql\`rating DESC, created_at DESC\``used as`ORDER BY ${rankingOrderSql()}`.
- **App↔ext share = codegen + committed file + sync test.** Extension has NO bundler and web-ext/rsync load raw files → the generated file MUST be committed. It sets `window.CaramelCoupons` — the extension's established cross-file pattern (`window.CaramelCartSignals` already works content-script→content-script), avoiding classic-script `const`-scoping guesswork. _Rejected:_ npm workspace package (extension has no build to resolve it).
- **Domain vs presentation:** shared surface = statuses + `label` + `tier`(green/amber/grey/red) + visible/restricted flags. The 4-row `tier→Tailwind` (app) and `tier→hex` (popup) maps stay local — genuinely platform-specific, cannot drift on the 9-status axis. This kills the real drift (7-status predicate ×6, label dup, restricted-set ×3) without leaking Tailwind into the extension.
- **Ban raw form (v5 RBC-2):** a vitest gate (not eslint — must span app TS + extension JS in one honest, low-noise place) fails if the distinctive tokens `valid_with_warning|product_restriction|category_restricted|seller_specific` or `status IN (` appear outside the allowlist. Bare `'valid'` is NOT banned (too common).

### Per-site drift ruling (the heart)

| Site                                   | Current                                 | Ruling → action                                                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| coupons/route.ts:48                    | full 7 + `expired=FALSE`                | UNIFY → `conditions=[visibleCouponsWhere()]`                                                                                                                                                                                               |
| (marketing) page.tsx:47 (used :55,:62) | full 7 + expired                        | UNIFY → import; ranking :57 → `rankingOrderSql()`                                                                                                                                                                                          |
| sites/top-sites:13                     | full 7 + expired                        | UNIFY                                                                                                                                                                                                                                      |
| sites/search-supported:24              | full 7 + expired                        | UNIFY                                                                                                                                                                                                                                      |
| coupons/stores:18                      | full 7 + expired                        | UNIFY                                                                                                                                                                                                                                      |
| coupons/stores:25                      | full 7 + expired                        | UNIFY                                                                                                                                                                                                                                      |
| coupons/route.ts:99                    | `ORDER BY rating DESC, created_at DESC` | UNIFY → `rankingOrderSql()`                                                                                                                                                                                                                |
| coupons/filters:20,28                  | `status='valid' AND expired=FALSE`      | **ACCIDENTAL DRIFT → UNIFY to `visibleCouponsWhere()`** — dropdown must reflect the same catalog the list surfaces (pending/restricted sites appear in results but not the filter today). **Behavior change; flagged §Breaking.**          |
| coupons/stats:15                       | `status='valid'` (NO expired)           | **DELIBERATE → `verifiedCensusSql()`**, behavior unchanged — it reports total-vs-**expired** among _verified_ coupons (a trust census), so it must include expired and exclude pending. Name reveals intent; not the visibility predicate. |

## Sequencing (each step ends with its check)

1. **Pins first (F-004):** `coupons.test.ts` pinning `VISIBLE_COUPON_STATUSES` (exact 7, order), `RESTRICTED_COUPON_STATUSES` (exact 4), `COUPON_STATUSES` (9), predicate truth-tables, and `STATUS_META` labels+tiers (verbatim from coupon-card + popup BADGE). ✔ `pnpm --filter caramel-landing test` green (asserts today's vocabulary before any move).
2. Create `coupons.ts` from `STATUS_TABLE`; point `types/coupon.ts` `CouponStatus` at it (re-export). ✔ pins green; `pnpm tsc --noEmit` green.
3. Add server fragments to `couponsDb.ts`; add `coupons-sql.test.ts` asserting each factory builds without throw and its serialized SQL matches the pinned shape (primary: postgres.js fragment `.strings`+parameters helper; fallback: assert factory consumes `VISIBLE_COUPON_STATUSES`). ✔ test green, tsc green.
4. Rewrite the 6 verbatim sites + 2 ranking sites + filters + stats per the table. ✔ tsc + lint + prettier green; pins green; grep shows zero `status IN (` in `src/app`.
5. Rebuild `coupon-card.tsx` `STATUS_BADGE` from `STATUS_META` + local `TIER_CLS`. ✔ tsc green; badge labels unchanged (snapshot/pin).
6. Codegen: write `scripts/generate-coupon-constants.ts` + `generate:coupon-constants` script; run it to emit the committed ext file; add `coupon-constants.generated.test.ts` (regenerate in-memory == committed bytes). ✔ script runs; sync test green; knip sees the script via the package script.
7. Wire ext consumers: prepend generated file to `manifest.json`/`manifest-firefox.json` `content_scripts.js` and to `index.html`; rebind `shared-utils.js:1054` to `window.CaramelCoupons.RESTRICTED_STATUSES` (one line — keeps F-008 rebase clean); replace popup `restrictedSet`/`BADGE` with `window.CaramelCoupons.*` + local `TIER_HEX`; add generated file to ext `.prettierignore`/eslint ignore. ✔ `pnpm --filter caramel-extension lint && prettier-check`; `node scripts/test-extension.mjs`; manual `web-ext run` popup renders badges.
8. Add the ban gate `no-raw-coupon-status.test.ts` (fs-walk app `src` + extension; forbid the 4 tokens + `status IN (` outside allowlist = `coupons.ts`, `coupon-constants.generated.js`, `*.test.ts`). ✔ green now; **plant a violation** (temp `const x='valid_with_warning'` in a route) → test RED → revert → green (rules-become-checks proof).

## Breaking changes

- **coupons/filters behavior change (only one):** the site/type filter dropdowns broaden from `status='valid'` to the full visible set (pending/retry/restricted). Consumer = `coupon-filters.tsx` dropdowns; user-visible = more sites/types listed, now consistent with `/api/coupons`. No API shape change. **Cannot be auto-verified** (coupons DB is external, absent in CI) → manual check on staging: `GET /api/coupons/filters` site count before/after. Trivial rollback: swap that one call back to `verifiedCensusSql()`+`AND expired=FALSE`.
- **Extension:** no behavior change (label/restricted sets identical); adds one script file to load order. Ships in the next extension release; no server coordination (unlike F-003).
- No DB, env, or response-shape changes.

## Test strategy

- **Pins BEFORE change (step 1):** the vocabulary + `STATUS_META` are the real safety net — every route WHERE and every badge derives from them, so pinning them pins behavior at the source. Fragment serialization pinned in step 3.
- **Post-change:** all unified sites import the fragments (tsc proves wiring); stats/filters express intent via named fragments; `coupon-constants.generated.test.ts` guards app↔ext sync; ban gate proven RED-then-green.
- **"Green" =** `pnpm --filter caramel-landing test` (vitest, F-004) + `tsc`/`lint`/`prettier`/`knip` all pass; extension `lint`/`prettier-check` + `test-extension.mjs` pass. **Honest limitation:** coupon _row_ behavior (which coupons match) is unverifiable in CI (no coupons DB); covered by vocabulary pins + staging/prod E2E, stated in Risk.

## Rollback

Single `fix(F-006): ...` commit; internal checkpoints at steps 1/3/6/7 (each independently green) so a failed later step restarts without losing pins. Revert = drop the commit (fragments/module/generated file/ext edits all removed together; sites return to inline predicate). The filters ruling is a 1-line intra-commit revert if the reviewer deems it deliberate.

## Risk

- **Blast radius:** all coupon read routes + the marketing SSR page + both extension UIs. **Worst case:** a fragment mis-composes and a route 500s (caught → today's `{error}` 500) or renders empty — caught early by tsc + manual route hit. **Extension worst case:** load-order miss → `window.CaramelCoupons` undefined → popup throws; caught by `web-ext` manual render (step 7) and `test-extension.mjs`.
- **Early warning:** sync test red = someone edited `coupons.ts` without regenerating; ban gate red = a raw token crept back.
- **Verified in code:** all 9 status sites (grep-exhaustive; `sources/route.ts s.status='ACTIVE'` is the scraper table, excluded); labels identical across app/popup (safe to merge); `resolveJsonModule`+`tsx` present; `window.Caramel*` cross-file sharing proven. **Assumed:** postgres.js `sql(array)` IN-expansion + fragment `.strings` inspection API (v3.4.9) — step 3 fallback covers if the inspection API differs.
