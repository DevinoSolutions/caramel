# Extension E2E RE-VERIFICATION — 6 landed fixes vs NEW code + REAL prod coupon data

Branch `dev` (audit/dev-2026-07-10). Fresh, logged-out (guest) user against a local `next dev` on
:58000 wired to the READ-ONLY local copy of the real prod coupon DB (`caramel-local-postgres-1`
@:58005 — 23,167 coupons / 1,399 active configs). All six fixes are present on this branch (commits
`654fb36` D1, `455ff53` sources, `9d6b00b` D3, `d2d2bc3` D4, `fae5a92` D5) and were the system under
test. Repo left pristine (only this file written).

## Rig (identical recipe to `ext-e2e-report.md`)

- **Server**: `pnpm --filter caramel-app dev`, launch-env overrides (no `.env` edit):
  `COUPONS_DATABASE_URL=…@localhost:58005/caramel_coupons`, `BETTER_AUTH_URL`/`NEXT_PUBLIC_BASE_URL=http://localhost:58000`,
  `UPKUMA_HEALTH_SECRET=e2e-secret`. Verified `/api/health/db` Bearer→**200 (coupons_db ok)**, no-Bearer→**401**.
- **Extension**: `apps/caramel-extension` copied to scratch, 3 dev-base-URL swaps to `http://localhost:58000`
  (`background.js:21` SW fetch, `popup.js:9` popup fetch, `caramel-base.js:116` CARAMEL_ALLOWED_ORIGINS).
  Loaded via Playwright 1.59.1 `chromium.launchPersistentContext({headless:false, --load-extension})`,
  SW id `ldopjlhflmbhhkblgihciabanlfbbecf`. Auto-inject driven with `context.route` serving a controlled
  eBay checkout (eBay's REAL DB selectors + REAL coupons + REAL content-script state machine); popup
  active-tab stubbed via `?e2eDomain=` (environmental only — all fetch/render real).

## Results

| #   | Fix                                | Expected                                    | Observed                                                                                                                                                                                                                            | Verdict  |
| --- | ---------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | D1 supported-stores                | 859 stores incl. trio                       | `GET /api/extension/supported-stores`→**859**; ebay.com/amazon.com/codecademy.com all present; ebay `successIndicator`=NULL (the now-dropped field)                                                                                 | **PASS** |
| 1   | D1 eBay auto-inject **(flagship)** | prompt auto-injects, honest modal           | prompt **AUTO-INJECTED** on ebay.com; loop ran REAL codes ("Trying coupon 1 of 8 (10PERCENTOFFALL)…"); honest final **"Grab a code / Auto-apply didn't stick — copy a code"** + 8 real codes; no crash, no false savings            | **PASS** |
| 2   | sources                            | 200 empty `data:[]`, schema OK              | `GET /api/sources`→**200** `{data:[]}` (sources table empty in real data), NOT 500; `check:coupons-schema`→**exit 0** ("all 33 columns present across 4 tables")                                                                    | **PASS** |
| 3   | D3 SPA attr-toggle                 | style/class reveal fires prompt             | pre-rendered **hidden** `input[name=redemptionCode]` revealed by **style-only** toggle (no node insert): prompt absent before → **appears after**                                                                                   | **PASS** |
| 4   | D4 popup loader                    | spinner outlives 400ms until fetch resolves | coupon fetch throttled ~3s: @700ms loader **still visible**, content not yet rendered; content rendered @**3163ms**, loader then hidden (vs old fixed-400ms blank gap)                                                              | **PASS** |
| 5   | D5 classify-cart origin            | no-Origin→403; ext-Origin→200               | curl no-Origin→**403** (gate fires before body); `Origin: chrome-extension://fake`+valid body→**200** real classify; in-browser SW fetch carried `Origin: chrome-extension://<id>`, status **200**                                  | **PASS** |
| 6   | Regression                         | popup states, guest, no errors              | popup coupons ("Coupons for ebay.com", 20 items/20 badges), empty ("No coupons for this site yet"), error ("Couldn't load coupons"+retry) all render; guest auto-inject ran (storage token ABSENT); **zero uncaught JS/pageerrors** | **PASS** |

## Flagship — eBay auto-inject now works END-TO-END

Screenshots (scratch `shots/`): **`ebay-1-prompt.png`** (prompt auto-injected), `ebay-2-testing.png`
(loop trying real codes), **`ebay-3-final.png`** (honest "Grab a code" modal). A live eBay guest
checkout is unreachable/bot-gated, so — as in the original report — I used the `context.route`
controlled checkout, but with eBay's REAL selectors (`input[name='redemptionCode']` /
`button[data-test-id='INCENTIVES_ADD_BUTTON']` from the DB) + the REAL 20-coupon list + the REAL state
machine. Before the fix ebay was absent from the 828-store list and the prompt never fired; now it is
1 of 859 and auto-injects. D3: `d3-toggle-prompt.png`; D4: `d4-loader-at700ms.png` + `d4-loader-after.png`.

## New defects

**None.** One expected, non-defect artifact: a single console `404` for `https://www.ebay.com/cart.js`
— the extension's own `probeCartJson()` capability probe (coupon-apply.js:418), gracefully handled
(try/catch → null → DOM apply path), and identical on any real non-Shopify checkout in prod. It is a
network-resource log, NOT an uncaught JS error; zero `pageerror`s across page / content-script /
service-worker.

## Teardown

Server killed by exact PID (730772, :58000) — never by image name; Playwright Chromium closed via its
own `chrome-profile-e2e` userDataDir, unrelated chromium/MCP browsers untouched. NO local-DB rows
mutated (reads + LLM classify only; `sources` POST never exercised) → nothing to restore; coupons table
at 23,167. Scratch extension copy + browser profiles deleted. Repo unchanged except this file.
