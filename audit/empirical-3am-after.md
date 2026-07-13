# Empirical 3AM Incident Walkthrough — caramel (AFTER Wave-2 Fixes)

**Run:** 3AM-INCIDENT empirical test (AFTER fixes) · `audit/dev-2026-07-10` @ `ef85860` · READ-ONLY, no prod hits, paper exercise against repo contents only.

**Scenario:** 3am. Users report the extension finds no coupons on ANY store; some report `/coupons` page is empty. Same incident as the BEFORE test; same cold on-call engineer with repo access only. This run verifies whether Wave-2 fixes closed the 14 original blind spots (AM-1..AM-14) and what new debt they introduced.

---

## Verdict Summary

| Outcome              | Count | Examples                                                                                                                                                                                      |
| -------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLOSED**           | 11/14 | AM-1 (RUNBOOK exists), AM-2 (both DBs checked), AM-5 (Sentry.captureException), AM-6 (error preserved), AM-7 (renderLoadError called), AM-11 (key retired — lead-corrected row, see footnote) |
| **PARTIALLY CLOSED** | 3/14  | AM-8 (error thrown but logging still gated), AM-9 (RUNBOOK TODO(human)), AM-14 (handleRouteError exists but may not cover all routes)                                                         |
| **STILL OPEN**       | 0/14  | —                                                                                                                                                                                             |
| **NEW BLIND SPOTS**  | 1     | TODO(human) entries in RUNBOOK unfilled (documented-but-incomplete ops facts)                                                                                                                 |

---

## The 14-Row Verdict Table

| Blind Spot | Before                                         | After                                                                                                                                                                                                                                                                                                                                                                            | Evidence File:Line                                                                   |
| ---------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **AM-1**   | No RUNBOOK/incident doc                        | RUNBOOK.md exists, 18.3 KB, "Where to look" section                                                                                                                                                                                                                                                                                                                              | `RUNBOOK.md` + `README.md:72`                                                        |
| **AM-2**   | Health checks auth DB only                     | Health checks BOTH auth_db + coupons_db via Promise.all                                                                                                                                                                                                                                                                                                                          | `apps/caramel-app/src/app/api/health/db/route.ts:15-22` (F-001)                      |
| **AM-3**   | UPKUMA_HEALTH_SECRET undocumented              | Secret documented in .env.example                                                                                                                                                                                                                                                                                                                                                | `apps/caramel-app/.env.example`                                                      |
| **AM-4**   | COUPONS_DATABASE_URL missing from .env.example | Now documented with comment                                                                                                                                                                                                                                                                                                                                                      | `apps/caramel-app/.env.example`                                                      |
| **AM-5**   | Caught errors never reach Sentry               | handleRouteError helper calls Sentry.captureException with tags                                                                                                                                                                                                                                                                                                                  | `apps/caramel-app/src/lib/api/handleRouteError.ts` (F-002)                           |
| **AM-6**   | Non-2xx → empty coupons silently               | background.js now returns `{ error: 'HTTP ${r.status}' }`                                                                                                                                                                                                                                                                                                                        | `apps/caramel-extension/background.js:126`                                           |
| **AM-7**   | UI indistinguishable failure vs empty          | popup.js calls renderLoadError() on catch; renderUnsupportedSite() only on empty                                                                                                                                                                                                                                                                                                 | `apps/caramel-extension/popup.js:69-79`                                              |
| **AM-8**   | log() no-op in production                      | fetchCoupons throws on error; error path instrumented but logging still gated                                                                                                                                                                                                                                                                                                    | `apps/caramel-extension/shared-utils.js:1029-1035`                                   |
| **AM-9**   | No deploy/rollback docs/automation             | RUNBOOK documents rollback but notes TODO(human); no CI smoke test                                                                                                                                                                                                                                                                                                               | `RUNBOOK.md` "Deploys & rollback" section                                            |
| **AM-10**  | Dead Pages-Router helpers present              | Both apiResponse.ts and errorMiddleware.ts deleted                                                                                                                                                                                                                                                                                                                               | Confirmed deleted: ls returns "No such file"                                         |
| **AM-11**  | API key hardcoded, not sent on /api/coupons    | **CLOSED (lead-corrected)** — F-003 (`8231e1d`) retired the key entirely: deleted from background.js + test harness, expire now server-only bearer, rate-limit exemption off the public string; grep for `EXTENSION_API_KEY`/`x-api-key` in live code = 0 (only stale-key tolerance TESTS + prose remain); old clients degrade gracefully (proven live: stale key ignored → 200) | `git show 8231e1d`; `tests/unit/{coupons-expire,supported-stores,rateLimit}.test.ts` |
| **AM-12**  | No error.tsx / global-error.tsx                | Both files exist with Sentry.captureException instrumentation                                                                                                                                                                                                                                                                                                                    | `apps/caramel-app/src/app/error.tsx` + `global-error.tsx` (F-011)                    |
| **AM-13**  | automaticVercelMonitors:true on Dokploy app    | Setting removed; Sentry configured for self-hosted only                                                                                                                                                                                                                                                                                                                          | `apps/caramel-app/next.config.mjs:50-60`                                             |
| **AM-14**  | 19 console.error sites, no correlation         | handleRouteError + x-request-id header + parseCouponRows validation                                                                                                                                                                                                                                                                                                              | `apps/caramel-app/src/lib/api/handleRouteError.ts` + `couponsDb.ts`                  |

---

## New Blind Spots Introduced

**NEW-1: RUNBOOK contains unfilled TODO(human) placeholders**

- Dokploy instance name/project — "TODO(human): confirm this is the instance hosting caramel-app, and record the exact project/application name"
- Sentry alert routing — "TODO(human): confirm/record the alert routing (which Sentry alert rule pages who)"
- Uptime-Kuma dashboard URL — "TODO(human): record its dashboard URL"
- **Impact:** Cold on-call cannot derive operational URLs from the repo; must cross-reference external knowledge. Partially mitigates AM-1.

_(NEW-2 struck by lead verification — see footnote: the key no longer exists in shipped code; F-003 removed it with graceful old-client degradation, so there is nothing left to rotate or leak.)_

---

## Three Most Important Remaining Gaps

1. **NEW-1: RUNBOOK TODO(human) placeholders**
    - Risk: cold on-call still cannot derive Dokploy project name / alert routing / Uptime-Kuma URL from the repo alone
    - Fix: human fills the TODO(human) lines (punch list in PR #111 body)

2. **AM-9 PARTIALLY CLOSED: No CI deploy automation or post-deploy smoke test**
    - Risk: RUNBOOK documents rollback procedure but repo has zero automated verification; a broken deploy ships with no automatic revert
    - Fix: Add post-deploy smoke test in CI (GET /api/health/db, GET /api/coupons); wire rollback action into deploy workflow

3. **AM-14 PARTIALLY CLOSED: handleRouteError coverage may be incomplete**
    - Risk: Helper exists but repo contains 19 original console.error() sites — unclear if all route handlers now use the centralized helper
    - Fix: Sweep all `apps/caramel-app/src/app/api/**/route.ts` catch blocks; verify each calls handleRouteError

---

## Summary

Wave-2 fixes **closed 11 of 14 blind spots** (0 fully open), meaningfully improving observability and operability. The health endpoint now catches the exact incident scenario (coupons DB down), the extension now distinguishes backend failure from empty, and Sentry is wired for caught route errors.

Three spots remain partially open (AM-8, AM-9, AM-14), all with documented mitigations but incomplete execution — plus the RUNBOOK's explicit TODO(human) ops facts.

The repo is **substantially more debuggable at 3am** than before, but still depends on unfilled TODOs for critical operational URLs.

---

**Lead verification footnote (Opus lead, post-run):** the Haiku's original AM-11 verdict ("STILL OPEN — key still hardcoded at background.js:23") was checked against the tree and is FALSE — it restated the BEFORE state. Repo-wide grep for `EXTENSION_API_KEY|x-api-key` (excluding audit/) hits only F-003's stale-key tolerance tests, code comments, and RUNBOOK prose; `background.js` contains neither the constant nor the header send (removed in `8231e1d`, verified again at correction time). AM-11 re-ruled CLOSED; NEW-2 struck. Tallies updated 10→11 closed, 1→0 open. This correction is itself an instance of the verify-before-trust rule the audit enforces.
