# PLAN-F-013 — `any`-typed exported surfaces poison callers

**Finding:** F-013 (Medium, conf 0.85, category typing) · **Effort:** M · **Wave:** 4 · **Sequence:** 11 (Wave-4 opener) · **Depends-on:** F-004 (vitest infra), F-002 (rewrote/typed `decryptJsonData`), F-009 (deleted the NextApi\* fossils = 8 census `any`s gone).

## Premise check (verified in code @0c0a991)

- CONFIRMED: `decryptJsonData.ts:3` `(resData:any):any`; `cryptoHelpers.ts:63` `encryptJsonServer(...,payload:any)` + `:82` `decryptJsonClient():any`; `apiResponseNext.ts:36-37`; `coupon-filters.tsx` 6 style callbacks (8 `any` tokens, lines 92/106/111/123/127/131).
- **CORRECTION (material):** the finding labels the apiResponseNext anys "metadata/viewport". They are actually **`data`/`error`** (lines 36-37); there is **no `metadata:any`/`viewport:any` anywhere in src** (full census). Plan targets `data`/`error`.
- Census now = 26 `any` tokens / 10 files (finding said ~23). After F-002 (`decryptJsonData`) + F-009 (initMiddleware, withAuth, withRoles, apiResponse = 8 tokens) land, ~16 remain — all mine. `extension/scripts/test-cart-signals.mjs:32` is a comment, not a type.

## Executive summary

Type the surviving `any` (exported surfaces first, then interior), then flip `@typescript-eslint/no-explicit-any` to **error**. ~7 files, **0 runtime change** (annotations only). Non-breaking except one tightened return (`decryptJsonClient(): any → unknown`), which is the **riskiest step** — it ripples through F-002's `decryptJsonData` into `sources/page.tsx`.

## Scope

**Step 0 (mandatory):** re-census the post-Wave-3 tree — `git grep -nE ':\s*any\b|<any>|\bas any\b|any\[\]' -- apps/caramel-app/src` — executor works the ACTUAL list, using the map below as the expectation.
**Modify — exported (first, kills contagion):**

- `src/lib/apiResponseNext.ts:36-37` — `data: any=null, error: any=null` → `unknown`.
- `src/lib/securityHelpers/cryptoHelpers.ts:63` — `payload: any` → `unknown`; `:82` return `any` → `unknown`.
- `src/lib/securityHelpers/decryptJsonData.ts:3` — expected already typed by F-002; if re-census still shows `any`, type param `unknown` + return per F-002 (do NOT touch its runtime).
  **Modify — interior:**
- `src/components/coupons/coupon-filters.tsx:90-137` — annotate `selectStyles` as `StylesConfig<Option, false>`; delete every `(base:any[,state:any])`.
- `src/app/(marketing)/sources/page.tsx:101,102,226` — replace `... as any` with honest coercion (step 5).
- `src/app/api/extension/oauth/route.ts:41` — `let payload: any` → local `interface OAuthStatePayload { provider:string; redirectUri:string; iat:number }` typing (accesses at 48-53 stay identical).
  **Modify — enforcement:** root `eslint.config.mjs` rules block — add `'@typescript-eslint/no-explicit-any': 'error'`.
  **Create:** vitest pins under F-004 infra (Test strategy).
  **OUT of scope:** fossil `any`s (F-009); `decryptJsonData` runtime/return semantics (F-002 — seam-typing follow-through only); duplicate XOR crypto (DD4-3); `successRate` name collision (CT-7); any tsc loosening.

## Approach

- **Exported→interior order** per finding (contagion first).
- **`unknown` over generics/interfaces** for pure serialize/parse boundaries (`nextApiResponse` data/error, `encryptJsonServer` payload, `decryptJsonClient` return): param-widening is non-breaking, honest for a JSON passthrough; a `<T>` generic over-engineers it. Rejected: a payload interface for `nextApiResponse` — callers pass heterogeneous shapes, `unknown` is correct.
- **react-select:** annotate the object `StylesConfig<Option, false>` and let params infer (context7-confirmed: `styles` type is `StylesConfig{}`, callbacks `(base, state)`). `Option` is in-component (line 27); both selects are single (`false`). Rejected: inline `base:CSSObjectWithLabel, state:ControlProps<…>` per key — verbose, a second way.
- **Enforcement via eslint** (already the app's `lint`): `eslint-config-next@16.0.3` registers the `@typescript-eslint` plugin, so the rule resolves **without** adding `@typescript-eslint/eslint-plugin` (would touch package.json+lockfile — avoid, F-014 is after me). **Fallback:** if the rule name doesn't resolve under next's flat config, enforce via oxlint (F-009) `typescript/no-explicit-any` instead — no new dep. oxlint is complementary; the ERROR gate is eslint per tasking.

## Sequencing (each step ends with its check)

1. **Re-census** (step 0). Record the live list. ✓ matches map ± upstream drift.
2. **Write pins FIRST** (Test strategy) under F-004 vitest; run green on current behavior. ✓ `pnpm --filter caramel-app test` green.
3. **Type exported surfaces** (`apiResponseNext.ts`, `cryptoHelpers.ts` ×2, `decryptJsonData.ts` if still `any`). Resolve the `decryptJsonClient→unknown` ripple with narrowing/assertion at the `decryptJsonData` ↔ `sources/page.tsx:41 plainObj` seam (behavior-neutral). ✓ `pnpm -r type-check` green; pins green. **[checkpoint A]**
4. **Type coupon-filters** styles → `StylesConfig<Option,false>`, drop annotations. ✓ tsc green; Argos/Playwright visual unchanged.
5. **Type interior** (`oauth/route.ts`; `sources/page.tsx`): determine each field's real post-F-002 type — if `numberOfCoupons`/`successRate` are already `number`, drop the cast (and redundant `parseInt`/`parseFloat`) or `String(...)`; **if a cast is hiding a real type mismatch (a bug) → STOP, file a new finding, do not paper over it.** ✓ tsc green; pins green. **[checkpoint B]**
6. **Enforce**: add the rule as `error`; lint. ✓ `pnpm --filter caramel-app lint` green with **0 `eslint-disable`** (grep confirms; repo has zero today). Any genuinely-unfixable `any` → single dated-reason suppression (expected count: 0).

## Breaking changes

Type-level only; **no runtime change**. `nextApiResponse`/`encryptJsonServer` params widen (`any`→`unknown`) → non-breaking to all 7+ call sites. `decryptJsonClient` return tightens (`any`→`unknown`): consumers = `decryptJsonData` (F-002's) → `sources/page.tsx:41`. Mitigation: narrow/assert at that seam in-commit; window = none (atomic). eslint→error turns CI red only if a stray `any` slips (mitigated by step-1 re-census + step-6 grep).

## Test strategy

- **Pins (vitest, F-004 infra, BEFORE the change; use encryption-disabled paths to avoid window/jsdom):**
    - `apiResponseNext.test.ts`: enc-off → 200 body `{status:'success',message,data}`; 400/500 → `{status:'error',…}`. Pins the `data`/`error` conditional-spread survives `unknown`.
    - `cryptoHelpers.test.ts`: `decrypt(encrypt(x,k),k) === x` (pure); JSON round-trips — pins parse behavior across the return-type tighten.
    - `decryptJsonData.test.ts`: enc-off passthrough (`pageData`/`response`/raw). **Coordinate with F-002's own pins — extend, don't duplicate.**
    - coupon-filters: no runtime delta → existing **Playwright + Argos** visual is the render pin.
- **"Green" =** tsc strict 0 errors (the real gate, AUDIT.md:136) + all pins green + eslint 0 errors, at each checkpoint.

## Rollback

Single commit `fix(F-013): type any exported surfaces + no-explicit-any error`. Checkpoints A (exported) / B (interior) are internal; a failed later step restarts from the last green checkpoint without losing pins. Revert = `git revert <sha>` (types + rule revert together; no data/schema impact).

## Risk

- **Blast radius:** `src/lib` boundary types + one component + one route + one page + eslint config. Worst case: `decryptJsonClient→unknown` cascades more type errors into F-002's decrypt path than expected. Early warning: `type-check` errors **outside** the three known seam files → a wider `any`-hidden mismatch (candidate STOP → new finding).
- **Verified in code:** every census anchor, all consumer traces (`nextApiResponse`←sources/route; `encryptJsonServer`←apiResponse fossil only; `decryptJsonClient`←decryptJsonData←sources/page), eslint flat-config structure, zero `eslint-disable`, react-select single-select usage. **Assumed (declared):** F-002's exact post-fix `decryptJsonData` signature and F-009's fossil deletion — both land before me; step-0 re-census reconciles.
