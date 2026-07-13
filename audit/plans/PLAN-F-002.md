# PLAN F-002 — Failures shaped as success + caught route errors bypass Sentry

**Finding:** F-002 (Critical, error-handling) · **Effort:** M · **Wave:** 2 · **Seq:** 5 (after F-003 key-split; before F-001 which consumes the new helper) · **Depends-on:** F-004 (vitest + jsdom/vm harness), F-003 (key split — no file overlap; sequencing only).

## Executive summary

- Three coordinated changes for ONE missing convention: (A) extension `background.js` stops collapsing non-2xx into fake-empty; (B) `decryptJsonData` throws instead of returning raw ciphertext; (C) new shared `handleRouteError` helper routes every caught route error to Sentry + one standardized `{error}` envelope, applied to 14 catch sites.
- ~19 files (1 new helper, 13 route files, `decryptJsonData.ts`, `sources/page.tsx`, `background.js`, + 3 test files). **Breaking: NO** for wire clients (status codes + dominant `{error}` shape preserved; only sources' error envelope changes, its sole consumer is hardened same-commit).
- Riskiest step: converting `sources/route.ts` 500 catches off the encrypted `nextApiResponse` envelope onto `{error}` — mitigated by hardening its one client consumer in the same step.

## Scope

**Create:** `apps/caramel-app/src/lib/api/handleRouteError.ts` (new `src/lib/api/` dir — follows `src/lib/**` convention; standalone fn F-007 later composes into its route wrapper). Tests: `handleRouteError.test.ts`, `decryptJsonData.test.ts` (co-located per F-004), extension pin in F-004's jsdom/vm harness.
**Modify (server, 13 route files / 14 catch sites → helper):** `classify-cart/route.ts:80` · `coupons/route.ts:120` · `coupons/increment/route.ts:49` · `coupons/stores/route.ts:41` · `coupons/stats/route.ts:35` · `coupons/expire/route.ts:58` · `coupons/filters/route.ts:53` · `sites/top-sites/route.ts:28` · `sites/search-supported/route.ts:33` · `sites/suggest/route.ts:18` (add `(error)` binding) · `extension/supported-stores/route.ts:93` · `extension/oauth/route.ts:588` · `sources/route.ts:66 & :115`.
**Modify (other):** `securityHelpers/decryptJsonData.ts` (throw + type) · `app/(marketing)/sources/page.tsx` (`fetchSources` honest-failure + decrypt-throw handling — sole `decryptJsonData` caller) · `caramel-extension/background.js:193,211` (return `{error}` not fake-empty).
**OUT of scope:** body-parse `.catch(()=>({}))/(=>null)` swallows (classify-cart:67, increment:20, sources:78, expire:24, suggest:5, oauth:83/163/389, search-supported:15) → F-007 wrapper (downstream-validated per standoff_caveat) · inner control-flow catches returning null/false/400 (coupons:10, sources:92/oauth-redirect:82 = 400 validation, oauth:22/44 = predicate false, oauth-redirect:43 = state fallback) · oauth:321/565 best-effort bearer swallows (no 500 boundary; note for F-007) · 5 SUCCESS shapes / full envelope unification → F-006/F-007 (we standardize the ERROR path only) · lint-ban of the pattern (needs custom-rule infra; no eslint, oxlint from F-009 = new follow-up finding) · `any` census → F-013 · `await` on sync `decryptJsonData` (harmless, behavior-neutral, leave).

## Approach

- **One helper, error-path only.** `handleRouteError(error, {message?, status=500, req?|route?})`: generates `requestId=crypto.randomUUID()`; `Sentry.captureException(error,{tags:{route,method,requestId}})`; returns `NextResponse.json({error:message},{status,headers:{'x-request-id':requestId}})`. Dominant existing error shape = `{error:string}` (13 routes) — adopt it verbatim; `requestId` lives in Sentry + header (additive, non-breaking), NOT the body. Rejected: adding requestId to body (would mutate the wire shape). Rejected: a global error-boundary middleware (Next 16 App Router has no route-level middleware seam; F-007 owns wrapping — helper must stay standalone). Rejected: converting SUCCESS shapes now (out of scope, breaks clients).
- **decrypt throws.** Replace `catch{return resData}` with `throw new DecryptError(err)`; add types (`resData: MaybeEncrypted|T`, `: T`, drop both `any`). Keep the `||` passthrough + if/else EXACTLY (behavior-neutral except the throw — no `||`→`??` drift). Rejected: returning a sentinel `null` (callers can't distinguish from valid null; throw is the honest signal).
- **Extension: honest contract already half-built.** Minimal change = `background.js:193/:211` return `{error:\`HTTP ${r.status}\`}`on non-2xx (mirrors the EXISTING`classifyCart`convention at background.js:167 — one way per thing). The consumer`shared-utils.js fetchCoupons()`(~L1026) ALREADY`throw`s on `resp.error`; `popup.js:71`ALREADY catches it →`renderLoadError()`("Couldn't load coupons", distinct from`renderUnsupportedSite`). So the honest UI EXISTS — the bug is purely that fake-empty starves it. No UI redesign; `supported-stores`consumer (shared-utils.js:337) already degrades`{error}`→expired-cache fallback. Extension has no Sentry — console.error + the existing `renderLoadError` UI is the accepted telemetry (state so explicitly).

## Sequencing (each step ends with its check)

1. **Pins first (RED).** Write all 3 flip-tests asserting NEW behavior; run → they FAIL against current code. Check: 3 reds, for the right reasons (empty-shape/decrypt-raw/no-Sentry). Checkpoint.
2. **Helper + unit test.** Create `handleRouteError.ts`; mock `@sentry/nextjs`. Check: `handleRouteError.test.ts` green (captureException called w/ tags; body `{error}`; status; `x-request-id` header).
3. **Apply to 14 server catch sites.** Each: `console.error` stays OR is dropped (helper logs via Sentry); `return handleRouteError(error,{req,message:'<existing msg>',status:<existing>})`. classify-cart passes `status: error instanceof OpenRouterError?502:500`. sources ×2: replace `nextApiResponse(req,500,…)` with helper. Check: `tsc` green; route pin (coupons mock-throws) → `{error}`+500+captureException called.
4. **decrypt throw + type + harden sole caller.** Rewrite `decryptJsonData`; in `sources/page.tsx fetchSources` add `if(!res.ok) throw new Error(\`HTTP ${res.status}\`)`before json, guard`Array.isArray(plainObj?.data)?…:[]`, add `error`state +`toast.error('Could not load sources')`, render distinct "Couldn't load sources" row vs "No sources found." Check: decrypt pin green (throws DecryptError; passthrough branches unchanged); `tsc` green.
5. **Extension shaping.** `background.js:193`→`{error:\`HTTP ${r.status}\`}`; `:211`→same. Check: extension pins green (background non-2xx → `{error}`; jsdom: `fetchCoupons`throw →`renderLoadError`DOM present, NOT`renderUnsupportedSite`).
6. **Squash → one commit** `fix(F-002): route-error Sentry helper + honest decrypt/extension failures`. Check: full targeted suite green; `pnpm -r type-check` green.

## Breaking changes

- **Server envelope:** 13 routes already emit `{error}` — unchanged. `sources/route.ts` error path changes from `nextApiResponse` envelope (`{status,message}`/encrypted) → `{error}`; **sole consumer** is in-repo `sources/page.tsx`, hardened in Step 4 (`if(!res.ok) throw`). All status codes (500/502/400) unchanged; `x-request-id` header additive. **Old extension clients** call coupons/supported-stores/classify-cart — those keep `{error}`+same status → NOT broken.
- **decryptJsonData throw:** only in-repo caller (sources/page.tsx) — handled same commit. No external caller (grep-verified).
- **Extension `{error}` on non-2xx:** ships in the extension bundle; consumers already tolerate it (fetchCoupons throws, supported-stores falls to cache, popup renderLoadError exists). Old in-the-wild extensions keep the buggy fake-empty until the store update lands — a delayed fix, not a server-side regression (server changes don't touch old extensions' happy path). No API-key/version coordination needed (that's F-003).

## Test strategy (F-004 infra; pins written BEFORE change, then flipped)

- **`handleRouteError.test.ts`** (new): mock Sentry → assert `captureException(err,{tags:{route,method,requestId}})` called once; response `{error:msg}`, given status, `x-request-id` present.
- **Route pin** (coupons/route.ts): mock `couponsSql` to throw → PIN was "returns 500, Sentry NOT called"; FLIP to "`{error:'Error fetching coupons.'}`+500 AND captureException called". (Proves caught errors now reach Sentry — the Critical gap.)
- **`decryptJsonData.test.ts`** (new): encryption on + `decryptJsonClient` mocked to throw → PIN "returns raw `{response}`"; FLIP to "throws `DecryptError`". Keep green passthrough pins for the not-enabled + no-key branches (behavior preserved).
- **Extension pin** (F-004 jsdom/vm harness, stub `chrome`/`currentBrowser`+`fetchWithTimeout`): invoke `onMessage` `fetchCoupons` with `{ok:false,status:500}` → PIN "responds `{coupons:[]}`"; FLIP to "`{error:'HTTP 500'}`". UI pin: stub `sendMessage`→`{error}`, run popup `initPopup` → assert `renderLoadError` DOM (`Couldn't load coupons`), NOT `renderUnsupportedSite`. Fallback if the listener resists vm-invocation: assert on an extracted shaping expression — but prefer through-the-listener (no new structure; F-008 owns shared-utils split).
- **"Green" =** Step-2 helper test; Step-3 route pins + `tsc`; Step-4 decrypt pin + `tsc`; Step-5 extension pins; Step-6 all green + `type-check`.

## Rollback

Checkpoints are logical (steps 1–5); final = ONE squashed commit. Pins are written FIRST so a failed step restarts without losing them (`git checkout -- <step files>`, pins persist). Full revert = drop the single `fix(F-002)` commit — no schema/data/deploy state touched; helper is purely additive; per-file edits are mechanical.

## Risk

- **Blast radius:** every API 500 path + extension coupon/store fetch + sources page. Worst case: helper mis-scopes and floods Sentry, or a converted route drops a needed header/status. Early warning: route pins assert exact status/body; `tsc`; a Sentry-quota spike post-deploy = mis-scope (helper only fires in catch, so bounded to real errors).
- **No double-report:** `onRequestError` (instrumentation.ts:12) handles UNCAUGHT errors; the helper handles CAUGHT ones (which never reach onRequestError) — disjoint, no duplication.
- **Premises — verified in code:** background.js:193/211 fake-empty; classifyCart:167 already `{error}` (existing convention to match); consumer fetchCoupons already throws on resp.error; popup `renderLoadError` already exists; decryptJsonData:20-22 returns raw on catch; **sole caller sources/page.tsx**; onRequestError wired; 14 catch sites enumerated; 2 error shapes (`{error}` dominant + `nextApiResponse` for sources only).
- **Divergence from lead direction (flagged):** lead said decrypt callers are handled "via the new helper **server-side**" — VERIFIED the sole `decryptJsonData` caller is a **client** component (`sources/page.tsx`, `'use client'`); the server helper does NOT apply to decrypt. Decrypt failure is handled at its client caller (toast + error state). This corrects the mechanism, not the fix's substance.
