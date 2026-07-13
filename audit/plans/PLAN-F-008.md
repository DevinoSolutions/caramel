# PLAN F-008 — split the 1536-line `shared-utils.js` god-module into honest files

**Finding:** F-008 (High) · **Effort:** L · **Wave:** 3 · **Sequence:** 10 (last of W3) · **Depends-on:** F-004 (vitest infra + shared-utils pins — extend them), F-006 (rewrote the RESTRICTED_STATUSES/`classifyCartCategory` region — rebase on its final commit), F-009 (size-limit config exists — add per-file budgets).

## Premise check (verified in code)

- TRUE: `apps/caramel-extension/shared-utils.js` = 1536 LOC, 14 banner-delimited sections, ≥8 unrelated responsibilities; #1 churn/LOC. Neighbour names mislead (all coupon logic is here; `inject.js` is an 8-line shim; `cart-signals.js` only collects DOM signals).
- CORRECTION (minor, does not change verdict): finding lists "modal UI :inside shared-utils" — it is NOT here. Modal UI lives in `UI-helpers.js` (defines `showTestingModal/updateTestingModal/hideTestingModal/showFinalModal/insertCaramelPrompt`); shared-utils only _calls_ them. **No modal-ui carve-out.** Real groups: bootstrap, timing/log, DOM-wait+price+query, store/domain/checkout, coupon-apply engine, coupon-fetch/classify, runner+listeners.
- `cart-signals.js` (IIFE→`window.CaramelCartSignals`) and `inject.js` (`log()` + `startCheckoutDetection()`) are honestly named → **NO renames** (the split alone kills the "shared-utils dumping-ground" lie).

## Executive summary

Mechanically cut `shared-utils.js` at its section banners into **6 cohesive, honestly-named plain-script files**, source-order preserved; delete `shared-utils.js`. Update 6 loaders. **Behavior change: ZERO** (move-only). ~13 files touched. **Breaking:** Y (ships as an extension release; user-invisible if pins hold). Riskiest step: loader arrays + test-harness eval-list — a wrong order/omission = extension silently dead on every store page.

## Scope

**Create (carved from shared-utils.js, source order preserved, each with a 2-line header `// owns: … // load after: …`):**

1. `caramel-base.js` — L1–83: `currentBrowser` bootstrap+double-load guard, `CARAMEL_ALLOWED_ORIGINS`, `sleep`/`log`/`recordTiming` fallback guards. (load 1st; no external deps)
2. `dom-utils.js` — L84–279: `_isVisible`,`waitForVisible`,`pickBestMatch`,`waitForElement`,`waitForTextChange`,`waitUntilReady`,`getPrice`,`_isXPath`,`qOne`,`qAll`.
3. `store-detect.js` — L280–543: `STORE_CACHE_*`,`_isDevInstall`,`_getCacheTtl`,`getDomainRecord`(+`.cache`),`_hostMatchesDomain`,`isCheckout`,`getCachedCodes`,`tryInitialize`,`startCheckoutDetection`,`_caramelCodes`.
4. `coupon-apply.js` — L544–1009: `GENERIC_*` selectors,`findAppliedSelector`,`findRemoveSelector`,`setInputValue`,`removeAppliedCoupon`,`_firstVisibleErrorEl`,`snapshotErrorState`,`ERROR_WORDS_RE`,`detectCouponError`,`applyCoupon`,`probeCartJson`,`CARAMEL_TRIED_*`,`_getTriedCodes`,`_markTriedCode`,`applyViaDiscountLink`.
5. `coupon-fetch.js` — L1010–1140: `fetchCoupons`,`RESTRICTED_STATUSES`,`classifyCartCategory`,`getCoupons`. **(F-006 rebase zone — re-anchor by symbol, not line.)**
6. `coupon-runner.js` — L1141–1536: `startApplyingCoupons`,`_caramelCancelled`, the window-`message` auth-bridge + `runtime.onMessage` listener block (L1499–1536).

**Modify:** `manifest.json` (content_scripts[0].js), `manifest-firefox.json` (content_scripts[0].js), `index.html` (script tags L61–63), `scripts/test-extension.mjs` (single-file eval → ordered list), F-004's vitest shared-utils loader (file list), F-009's size-limit config (drop shared-utils entry, add 6). **Delete:** `shared-utils.js`.
**OUT of scope (new findings, don't touch):** popup-minimization (loading only the 2 files popup needs — changes which listeners bind in popup realm); `manifest-firefox.json`'s `amazon.js` ghost + missing `cart-signals.js` (separate Firefox-parity finding); `background.js` duplicate `_isDevInstall`/`CARAMEL_BASE_URL` (dedup finding); renaming `cart-signals.js`/`inject.js`; any logic edit.

## Approach

Cut ONLY at existing banner boundaries; never reorder or edit bodies. Chosen because the whole file is hoisted function declarations + a handful of top-level executions whose sole load-time refs are `currentBrowser`/`CARAMEL_ALLOWED_ORIGINS` (both in file 1); every cross-file call sits inside a runtime callback. **Invariant: the 6 files loaded in listed order concatenate byte-for-byte to the original (modulo added headers)** — a `cat`-diff proves behavior-neutrality mechanically.
Rejected: bundler/ESM (violates the repo's no-bundler plain-script convention — would be a second way); finer split of `coupon-apply.js` (its `applyCoupon` + selector/error helpers are one cohesive concern — over-splitting hurts clarity, and F-009 size-limit sets the ceiling); popup-specific minimal script list (drive-by; alters listener binding).

## Sequencing (each step ends with its check; internal checkpoints, squash to ONE commit at end)

0. Rebase branch onto F-006's final commit; re-locate every symbol above **by name** (line numbers are pre-F-004/F-006 and will drift). Check: `grep` finds each identifier.
1. Write/extend pins on the STILL-WHOLE file (see Test strategy). Check: `node scripts/test-extension.mjs` + vitest → all green (baseline captured).
2. Cut file 1 `caramel-base.js`; in `manifest.json`/`manifest-firefox.json`/`index.html` replace `shared-utils.js` with `caramel-base.js` + (temporarily) keep remaining original as `shared-utils.js` after L83. Check: `cat` split+remainder == original; suites green. (Checkpoint commit.)
   3–7. Repeat cut for files 2→6 in order, each time moving its banner block out and inserting the filename into all three loaders in position; after file 6, `shared-utils.js` is empty → delete it. Check after EACH: `cat` files in load order == original pre-split file (byte-identical); suites green. (Checkpoint per file.)
3. Update `scripts/test-extension.mjs`: replace the `readFileSync('shared-utils.js')`+`eval` (step-7 block) with eval of the 6 `caramel-*` files in load order before the `applyCoupon('SAVE10',rec)` call; assertions unchanged. Check: harness green.
4. Update F-004 vitest loader (its shared-utils file list → the 6 files, in order) and F-009 size-limit config (remove shared-utils budget; add 6 entries, per-file limit ≈ largest split file rounded up, e.g. ~18KB). Check: vitest green; `size-limit` (or its CI job) passes.
5. Smoke: `pnpm --filter caramel-extension build` (rsync — auto-includes new files, no enumeration to edit) then `web-ext run` on a real supported store page; content script loads, no console `ReferenceError`, apply flow triggers. Squash checkpoints → `fix(F-008): split shared-utils.js into cohesive content-script files`.

## Breaking changes

Consumers = every `https://*/*` page's content-script realm + the popup realm (`index.html`) + the Playwright harness + F-004 vitest. All in-repo and updated in the same commit — no external API contract changes. Ships only when the extension is re-published (Chrome/Firefox store-review lag); installed users keep the old bundle until update. Tolerance window is benign because behavior is identical byte-for-byte; **coordinate: land in the next extension release, not a hotfix, and bump `manifest.json` version.** No server/app coordination needed.

## Test strategy (pins FIRST, via F-004 infra + existing harness)

Write BEFORE any cut, against the whole file; the SAME tests must pass unchanged after — that is the proof.

- **base:** `sleep(ms)` resolves; `log`/`recordTiming` no-throw. **dom-utils (jsdom):** `getPrice("$12.34")→12.34` & `returnLargest` picks max; `qOne`/`qAll` for CSS + `//`XPath; `_isXPath`; `_isVisible` false on `display:none`. **store-detect:** `_hostMatchesDomain('www.x.com','x.com')→true`; `getDomainRecord` caches (stub `currentBrowser.storage`+fetch); `_isDevInstall` reads `getManifest().update_url`. **coupon-apply:** `ERROR_WORDS_RE`/`detectCouponError` on a snapshotted DOM; `setInputValue` sets `.value`+fires `input`; **`applyCoupon` = the existing `test-extension.mjs` step-7 pin** (fills input, clicks apply, detects price change). **coupon-fetch:** `getCoupons` ranking + RESTRICTED_STATUSES→`classifyCartCategory` gate (stub messaging); `fetchCoupons` posts `{site,kw,category}`. **coupon-runner:** `startApplyingCoupons` loop over the fake store DOM; listener block idempotent (`__caramel_listeners_bound`).
- **Green means:** (a) baseline green on whole file; (b) after each cut, suites green AND `cat`-diff empty; (c) final: `node scripts/test-extension.mjs` + vitest green, `cat`-diff empty, `web-ext` smoke clean.

## Rollback

Per-file checkpoint commits (steps 2–7) on the scratch sequence; a failed cut = `git reset --hard` to the prior checkpoint (pins already committed at step 1, never lost). Final deliverable squashes to one `fix(F-008)` commit; revert = single `git revert` restoring `shared-utils.js` and the loader arrays atomically.

## Risk

Blast radius: ALL store pages + popup. Worst case: a symbol referenced at load before its defining file loads → `ReferenceError` at content-script load → extension silently dead everywhere. Mitigation: the source-order-preserving cut + `cat`-diff invariant makes load-time resolution identical to today by construction; `test-extension.mjs` catches `applyCoupon` breakage; `web-ext` smoke catches realm wiring. Early-warning: any non-empty `cat`-diff, any new console `ReferenceError`, a red harness. **Verified in code:** LOC/banners, full cross-file global graph, background independent, cart-signals/inject honest, build=blanket rsync, harness single-file eval, amazon.js ghost. **Assumed (re-anchor at fix time):** F-004 loader shape, F-006 final form of the RESTRICTED_STATUSES region, F-009 size-limit config shape — all land before F-008.
