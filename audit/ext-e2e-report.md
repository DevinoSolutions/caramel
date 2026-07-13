# Extension E2E report — auto-inject + popup, NEW code vs REAL prod coupon data

Branch `dev`. Tested as a fresh, logged-out user against a local `next dev` on :58000 wired to a
READ-ONLY copy of the real production coupon DB (23,167 coupons / 2,313 store configs). Deployed
dev/prod run OLD code (CR-7), so they were NOT the system under test except for the release-order check.

## Rig

- **Server**: `pnpm --filter caramel-app dev` on :58000 with launch-env overrides (no `.env` edit):
  `COUPONS_DATABASE_URL=…@localhost:58005/caramel_coupons`, `BETTER_AUTH_URL`/`NEXT_PUBLIC_BASE_URL=http://localhost:58000`,
  `UPKUMA_HEALTH_SECRET=e2e-secret`. Verified: `GET /api/health/db` (Bearer) → **200 `{status:ok, auth_db:ok, coupons_db:ok(37ms)}`**, no-Bearer → 401;
  `GET /api/coupons?site=ebay.com` → 200 total 22; `GET /api/extension/supported-stores` → 200, **828 stores**.
- **Extension**: repo `apps/caramel-extension` copied to scratch (excl. node_modules/tests/apple-extension). Scaffold edits (COPY only, repo pristine):
    1. `background.js:20-22` dev-install base URL `https://dev.grabcaramel.com` → `http://localhost:58000` (content-script fetch path)
    2. `popup.js:7-10` same dev base-URL swap (popup fetch path)
    3. `caramel-base.js:115-117` added `http://localhost:58000` to `CARAMEL_ALLOWED_ORIGINS`
       `manifest.json` **already ships** `http://localhost:58000/*` in `host_permissions` (no edit needed).
- **Load**: `chromium.launchPersistentContext` (headless:false, `--load-extension`), Playwright 1.59.1. SW booted (id `ldopjlhflmbhhkblgihciabanlfbbecf`);
  `chrome.storage.local.caramel_supported_stores` filled with **828 stores fetched from localhost:58000** → override proven. Popup site stubbed via one `addInitScript` on `getActiveTabDomainRecord` (environmental only); all fetch/render real. Auto-inject driven with `context.route` serving a controlled checkout for an in-list domain (dyson.com, 22 real coupons) so the REAL content-script state machine runs.

## Matrix

| #   | Case                                       | Expected                   | Observed                                                                                            | Verdict   | Evidence                          |
| --- | ------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------- | --------- | --------------------------------- |
| 1   | Popup, store w/ coupons (ebay)             | list renders               | "Coupons for ebay.com" + cards/Copy/badges, no errors                                               | PASS      | popup-1-ebay-coupons.png          |
| 2   | Popup, supported 0 coupons (codecademy)    | honest empty               | "No coupons for this site yet"                                                                      | PASS      | popup-2-codecademy-zero.png       |
| 3   | Popup, unsupported (wikipedia)             | honest unsupported         | same "No coupons" empty state                                                                       | PASS\*    | popup-3-untracked.png             |
| 4   | Popup, server DOWN                         | distinct error             | "Couldn't load coupons / Try again" @~3s                                                            | PASS      | down-2-error.png                  |
| 5   | Popup, slow network                        | document UX                | loader hidden ~0.7-1s while container **blank** (fixed 400ms timer)                                 | DEGRADED  | down-1-blankgap.png               |
| 6   | eBay auto-inject                           | prompt auto-injects        | **NO prompt** — ebay absent from 828-list; real ebay.com prompt=false                               | DEFECT    | autoinject-real-ebay.com.png      |
| 6b  | Auto-inject state machine (dyson, in-list) | apply loop honest          | win→"Savings Found $15, DYSONVIP", $100→$85; reject→honest "copy a code", 4 tries, no false savings | PASS      | autoinject-win/reject-3-final.png |
| 7   | Amazon auto-inject                         | cart prompt                | amazon.com **absent from 828-list** (same NULL fields) → cannot fire                                | DEFECT    | (DB + list)                       |
| 8   | SPA re-render                              | prompt survives/re-injects | style-toggle→**no prompt** (blind); node-insert→prompt appears                                      | DEFECT    | spa-toggle.png                    |
| 9   | Stale selectors                            | silent no-op               | no prompt; only trace = a no-op `log()` (invisible in prod)                                         | DEFECT    | (store-detect isCheckout=false)   |
| 10  | Config deactivated                         | graceful                   | dropped from list (828→827), no prompt; `/api/coupons` still returns 20                             | PASS      | (API)                             |
| 11  | Logged-out                                 | auto-inject works          | full win/reject ran as guest (no token)                                                             | PASS      | (6b runs)                         |
| 12  | classify-cart key/no-key                   | works / degrades           | key→200 `home_garden 0.95`; bogus key→**502**, coupons unaffected                                   | PASS      | (API)                             |
| 13  | Console hygiene                            | no uncaught errors         | JS_ERRORS **none** across every run                                                                 | PASS      | (all logs)                        |
| —   | Release-order                              | old server 401s keyless    | dev.grabcaramel.com supported-stores: no-key→**401**, with-key→200                                  | CONFIRMED | (API)                             |

\*Case 3 nuance: popup "supported" == `/api/coupons` returns rows, independent of the store-list. e.g. **etsy.com is absent from the 828 auto-inject list but has 20 coupons**, so its popup WOULD show coupons — "unsupported" only means zero coupons.

## Defects (ranked)

- **D1 (HIGH) — the 3 demo stores + 25% of active configs are excluded from auto-inject.** ebay.com, amazon.com, codecademy.com (the exact domains hardcoded in `supported.json` and `manifest-firefox.json`) each have `coupon_input`+`apply_button` but **success/error/remove xpaths = NULL**, so `route.ts:44-48` drops them → they never appear in `supported-stores` → auto-inject silently never fires on them (confirmed live on real ebay.com). 346 of 1,399 active configs (~25%) fail on exactly this trio; only 828 distinct stores qualify. ebay's own coupon row even carries `verificationMessage:"Coupon input selector was not found on https://cart.ebay.com/"`. Root cause is coupon-DB data quality, not extension code. **A demo/QA on ebay/amazon will show nothing and look "broken."**
- **D2 (HIGH, systemic) — zero production observability.** `log()` is a hard no-op in packed builds (`caramel-base.js:78-84`) and `recordTiming` is never transmitted. Every D1/D3/D4 silent failure (stale selectors, excluded store, blind toggle) is invisible to Caramel — only a user complaint surfaces it. The stale-selector test (case 9) produced no signal anywhere.
- **D3 (MED) — SPA attribute-toggle blind spot.** MutationObserver is `childList`-only (`store-detect.js:253-258`). A pre-rendered coupon box revealed by a class/style toggle (common on SPA/drawer carts) never re-triggers detection — reproduced: style-flip→no prompt, node-insert→prompt.
- **D4 (MED) — popup loader is a fixed 400ms timer.** `popup.js:38-40` hides the spinner at 400ms regardless of the up-to-8s fetch → blank-window gap on slow/degraded connections (observed: container blank at ~1s while loader already gone).
- **D5 (LOW) — classify-cart origin gate is permissive.** A request with NO `Origin` header still returned 200 (`rateLimit.ts:178-184` origin:true trusts by protocol / passes missing origin) — the paid LLM endpoint is reachable without an extension origin (rate-limit aside).

## Not tested / why

- Real third-party checkout end-to-end (actual dyson/chewy cart): non-stealth Playwright + guest-cart setup + bot detection make it unreliable; used a controlled `context.route` repro (real store list + real coupons + real state machine) instead. ebay/amazon are excluded regardless (D1).
- iframe-embedded checkout (no `all_frames`) and Firefox manifest drift (NF-03): architectural / Chromium-only harness — code-confirmed, not driven.
- Signup flow: login gates nothing (auto-inject + coupons work fully logged-out, case 11), so a throwaway account wasn't needed.

## Teardown

Server PID killed; all local-DB mutations restored (dyson cfg 14975/14976 is_active=true + `#voucherCode`/`.js-checkout-voucher-heading`; coupons table untouched at 23,167); scratch extension copy deleted. Repo unchanged except this file.
