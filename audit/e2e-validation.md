# E2E Validation — caramel audit fix train

Branch `audit/fixes-2026-07-10` @ `145fb10`. Validator: Opus E2E agent · 2026-07-11.

**Deviation (CR-7):** the 16 fixes are undeployed — prod runs OLD code — so functional validation ran against the **LOCAL boot** (`pnpm --filter caramel-app dev`, http://localhost:58000), the only place the new code runs. Prod got exactly **two read-only GETs** (item 6).

**Scaffolding = ephemeral env vars injected at boot only; NO files/source touched, no commits.** `UPKUMA_HEALTH_SECRET` + `CHROME_EXTENSION_ORIGIN` (both schema-optional and absent from local `.env`; needed to exercise the authorized-503 and CORS-reflection paths) and `NEXT_PUBLIC_BASE_URL`/`BETTER_AUTH_URL` aligned to `:58000` (local `.env` ships `:58300` — pre-existing **OB-12** base-URL mismatch; first boot live-confirmed it: every page emitted a `get-session` CONNECTION_REFUSED to `:58300`, gone once aligned). Shared pg/redis containers left running; own PIDs (809332, 810784) killed. Local coupons DB `caramel_coupons` absent by design → degraded mode is EXPECTED.

## Item 1 — Pages render clean (200 · content · no _new_ console errors · error boundary NOT on happy path)

| Page                | Method                   | Expected                                         | Observed                                                                                                                                                        | Verdict |
| ------------------- | ------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `/`                 | nav + evaluate + console | 200, content, 0 err                              | title ok, h1 "Welcome to", 4239 chars, **0 err**, no boundary                                                                                                   | PASS    |
| `/coupons`          | nav + evaluate + console | 200, honest empty/err state, only DB-absence err | renders "No coupons found / Try adjusting your filters"; **12 err = ALL /api/coupons(+filters,+stores) 500** (expected DB-absence, ×2 strict-mode), no boundary | PASS    |
| `/supported-stores` | "                        | 200, only DB-absence err                         | heading renders; **2 err = /api/sites/top-sites 500** (expected), no boundary                                                                                   | PASS    |
| `/pricing`          | "                        | 200, content, 0 err                              | 1181 chars, **0 err**, no boundary                                                                                                                              | PASS    |
| `/login`            | "                        | 200, form, 0 err                                 | email+password inputs, **0 err**, no boundary                                                                                                                   | PASS    |
| `/signup`           | "                        | 200, form, 0 err                                 | 4-input form, **0 err**, no boundary                                                                                                                            | PASS    |

Only non-error console noise anywhere: benign PWA `manifest.json display_override` warning + a Next/Image LCP hint — both pre-existing, non-fix-related.

## Item 2 — Honest failure UX (F-002), `/sources`

| Method                       | Expected                                                      | Observed                                                                                                                                                                                        | Verdict |
| ---------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| nav + DOM probe + screenshot | distinct "Couldn't load sources." row + toast, NOT fake-empty | only `<td>` = **"Couldn't load sources."**; "No sources found." **absent**; sonner toast **"Could not load sources"** captured; no boundary; the 4 console errs = `/api/sources` 500 (expected) | PASS    |

Screenshot proof saved to scratchpad `sources-honest-failure.png` (shows error row + toast together).

## Item 3 — API behaviors over real HTTP (curl)

| Call                                          | Expected                 | Observed                                                                                                                               | Verdict |
| --------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `GET /api/health/db` no bearer                | 401                      | `401 {"error":"Unauthorized"}`                                                                                                         | PASS    |
| `GET /api/health/db` valid bearer             | 503 dual-check           | `503 {status:"error",checks:{auth_db:{status:"ok",2066ms},coupons_db:{status:"error","database \"caramel_coupons\" does not exist"}}}` | PASS    |
| `GET /api/coupons?site=amazon.com`            | 500 {error}+x-request-id | `500 {"error":"Error fetching coupons."}` + `x-request-id`                                                                             | PASS    |
| `GET /api/extension/supported-stores` keyless | 500 {error}, NOT 401     | `500 {"error":"Internal server error"}` + `x-request-id`, no 401                                                                       | PASS    |
| `POST /api/coupons/expire` no bearer          | 401                      | `401 {"error":"Unauthorized"}` (fail-closed)                                                                                           | PASS    |
| `OPTIONS /api/extension/oauth` allowed Origin | 204 + CORS               | `204` + `ACAO: chrome-extension://…` + Allow-Methods/Headers; unlisted origin → `204` no reflection (deny-by-omission)                 | PASS    |
| `POST /api/extension/login {}`                | 422                      | `422 {"error":"Invalid request body"}`                                                                                                 | PASS    |
| `POST /api/sites/suggest {}`                  | 422                      | `422 {"error":"Invalid request body"}` (origin-gate allows no-Origin curl → reaches body check)                                        | PASS    |

## Item 4 — Error boundary (F-011)

| Method                            | Expected                         | Observed                                                                                                                                                                                                                                            | Verdict                                                                                                   |
| --------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| source read + live negative-proof | `error.tsx` present in built app | `error.tsx` + `global-error.tsx` present, correct Next 16/Sentry convention (captureException+reset+branded UI); compiled into running app; **NOT triggered on any of 7 live pages** (errBoundary:false). No throwing route added (no scaffolding). | PASS (unit/build-proven per F-011 126/126 + live negative-proof; runtime-trigger not exercised by design) |

## Item 5 — Extension smoke (real Chromium, unpacked ext)

| Method                                                                               | Expected                                                      | Observed                                                                                                                                                                                                                                                                                                                                                                                                     | Verdict |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Playwright `launchPersistentContext` + `--load-extension` + CDP isolated-world probe | SW registers clean; content scripts inject; no ReferenceError | SW registered `…/background.js`, `CARAMEL_BASE_URL=https://dev.grabcaramel.com` (talks to OLD dev server, fine); isolated world "Caramel - Trusted Honey Alternative" has `CaramelCoupons` (keys STATUSES/VISIBLE_STATUSES/RESTRICTED_STATUSES/STATUS_META), `currentBrowser`, `__caramel_shared_utils_loaded=true`, `CaramelCartSignals`; console `Caramel: Injected script`→`done`; **ReferenceErrors: 0** | PASS    |

Proves F-006 generated constants + all 6 F-008 split files load in manifest order without the cross-file-hoisting ReferenceError F-008 was cut to avoid. No login/oauth attempted (deferred post-merge).

## Item 6 — Prod disambiguation (READ-ONLY, 2 GETs, UA only)

| Call                                                      | Observed                                                         | Verdict                     |
| --------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------- |
| `GET https://grabcaramel.com/`                            | `200` text/html 11311B                                           | PASS                        |
| `GET https://grabcaramel.com/api/coupons?site=amazon.com` | `200` JSON, **non-empty `coupons[]`** of real amazon.com coupons | **Prod coupons DB is FINE** |

Resolution: the earlier "Dokploy env missing `COUPONS_DATABASE_URL`" note (F-012 flagged unverified) was an **env-layering misread** — prod serves real coupon data, so the var IS provisioned. No fix attempted (read-only).

## Item 7 — Console/UX sweep verdict

No anomalies attributable to the fix train. Every console error observed was either (a) the EXPECTED local `caramel_coupons`-absent degraded mode on coupon-backed surfaces (`/coupons`, `/supported-stores`, `/sources`), each caught and surfaced honestly (empty state / distinct error row / toast, never a crash or spurious error boundary), or (b) pre-existing/environmental (OB-12 `:58300` base-URL mismatch in the committed local `.env`; benign PWA-manifest + Next/Image warnings). All 16 fixes behave as designed end-to-end.

## For lead attention

- **OB-12 (docs/env, pre-existing):** committed local `apps/caramel-app/.env` sets `BETTER_AUTH_URL`/`NEXT_PUBLIC_BASE_URL` to `:58300` while the app runs on `:58000` → client `get-session` fails locally until aligned. Cosmetic locally; harmless in prod (prod sets them correctly). Onboarding-doc fix, not a code regression.
- **Item 6:** prod coupons DB confirmed healthy — retire the "prod missing COUPONS_DATABASE_URL" concern; no escalation needed.
- Local `.env` lacks `UPKUMA_HEALTH_SECRET` and `COUPONS_ADMIN_SECRET` (both schema-optional); injected ephemerally here to exercise those paths — add them to the local `.env` if you want these reachable without injection.
