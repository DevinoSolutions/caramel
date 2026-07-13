# Caramel — Codebase Audit

**Baseline:** `dev` @ `537547b3081aa3a0ec817cdc5f6dac4f0d328dbb` · **Rules:** shared-claude-rules v5 (2026-07-10) · **Date:** 2026-07-10
**Target branch (this run):** `audit/dev-2026-07-10` — all fix PRs target it, never `dev`/`main`.
**Gate mode:** pre-authorized (user directed "do PR to that branch") → triage/plan gates collapse into PR review; every self-decision logged in `audit/state.json`. No agent merges.
**Method:** dual Haiku hotspot scans (A∩B) → 4 Sonnet deep dives → 4 empirical tests (change-trace, 3am, onboarding, name-only navigation) → Opus pre-mortem → Haiku verification gate (3×) → Opus adversarial review → Fable synthesis. Deterministic tooling run separately. 82 candidate findings → 16 root causes.

---

## Executive summary

Caramel is a small, competently-built coupon product with a dangerous gap between how solid its happy path looks and how blind it goes the moment anything fails. Its core data — the coupon catalog — lives in a second Postgres owned by an out-of-repo Python service, read through untyped raw SQL, and the one health endpoint never checks it (F-001); when it or anything else breaks, the extension reports the outage to users as the factual claim "this store has no coupons," and the server errors behind it are caught-and-returned so they never reach Sentry (F-002). A static API key shipped in the public extension gates a destructive mutation and exempts its holder from rate limiting (F-003). There is no test suite at all — `pnpm test` is green while running zero tests (F-004) — so nothing protects any change. Maintainability is dragged down by a 1536-line extension god-module that is also the single most-churned file in the repo (F-008), coupon-domain logic copy-pasted across six-plus sites that have already drifted (F-006), and no shared request pipeline so CORS/rate-limit/auth are re-implemented or silently skipped per route (F-007). The guardrails that exist don't guard: dead Pages-Router fossils are whitelisted past knip, neither branch has protection, and half the target CI stack is missing (F-009). Docs get a new engineer only a partial boot (wrong port, undocumented second DB, no migration step) (F-010), and there is no runbook, rollback, or error boundary anywhere (F-011). The good news: TypeScript is strict and green, CI secrets are all real (0 phantom), the security architecture is sound, and function-level naming is excellent (10/10 in navigation testing) — the bones are fine; the failure-handling, testing, and operability layers are what compound. **Overall: 4/10 — fragile; tribal knowledge and no tests; safe changes are possible but require care.**

## Anchored scores (weighted to P1 maintainability + P2 operability)

| Dimension                   | Score | Anchor / evidence                                                                                                                                                                                                  |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Architecture                | 4     | Core data in an un-contracted external DB (F-001); no shared request pipeline (F-007); one-root-compose violated (F-016). App/extension split itself is sound.                                                     |
| Modularity                  | 4     | 1536-line god-module = #1 churn AND #1 LOC (F-008); no pipeline (F-007). Change-trace isolation: small 9/10, medium 3/10, **cross-cutting 1/10**.                                                                  |
| Clarity / conventions       | 4     | Name-only navigation: **behaviors 2/5 (40%)**, functions 10/10. File names imply modularity that's absent (F-008); 4 error styles, 5 envelope shapes, 3 missing-env strategies, 3 hand-copied CORS blocks (F-007). |
| Code health                 | 4     | Dead fossils whitelisted past knip (F-009); swallowed errors (F-002); ~23 `any`, several exported (F-013); stray/broken artifacts (F-015). tsc green, lint near-clean.                                             |
| Testing                     | 2     | **No suite exists**; `pnpm test` false-green ×2 (F-004). Nothing protects any path.                                                                                                                                |
| Operability                 | 3     | Health check probes the wrong DB (F-001); errors invisible to Sentry (F-002); no runbook/rollback/error-boundary (F-011); no branch protection (F-009); no env validation (F-005).                                 |
| Dependencies                | 4     | 83 vulns (2 crit/45 high), 50/51 outdated, deprecated dep, floating ^-ranges, nested lockfile (F-014). 0 phantom CI secrets (good).                                                                                |
| Docs                        | 3     | README has no getting-started; onboarding only partially boots; boilerplate READMEs; port drift (F-010).                                                                                                           |
| Security (regressions only) | 4     | One concrete Critical regression: public key gates mutation + rate-limit bypass (F-003); XOR-named-"encryption" (appendix). Architecture itself accepted as solid, out of scope.                                   |

**Verification integrity:** 15/15 findings verified with **0 ABSENT** (deletion counter 0 — clean hallucination meter). Adversarial review attacked 8, **killed 0**; strengthened F-006 & F-008, corrected F-009 (struck a live file), narrowed F-002's telemetry claim.

---

## Findings (Critical first)

### F-001 · Critical · The coupon catalog is an externally-owned, health-check-blind, untyped-raw-SQL dependency

The product's core data lives in a second Postgres (`caramel_coupons`) owned by an out-of-repo Python service, read via template-string SQL in `couponsDb.ts`; `health/db/route.ts` only runs `SELECT 1` against the auth DB and never touches the coupons DB (adversarial confirmed no second check exists). `COUPONS_DATABASE_URL` is undocumented. **Why:** a drift or outage in a DB this repo doesn't own zeroes out all coupons while every monitor stays green — the outage the 3am and pre-mortem passes both independently predicted. **Fix:** health-check the coupons DB distinctly; document the URL; add a typed/zod-validated read boundary + schema-drift check against the Python service. _(operability, M)_

### F-002 · Critical · Failures are shaped as success; caught-and-returned route errors bypass Sentry

The extension collapses any non-2xx into `{coupons:[]}`/`{supported:[]}` with no error field (`background.js:193`); `decryptJsonData` returns raw ciphertext on decrypt failure (`:20-22`). Uncaught errors _do_ reach Sentry (`instrumentation.ts:12` wires `onRequestError`), but the pervasive `try/catch → return 500` style means real route errors never get there. **Why:** in a product whose pitch is honesty, an outage renders to users as "this store has no coupons," and the server errors behind it are invisible. **Standoff caveat (attach to DESIGN):** the `.catch(()=>({}))` body-parse swallows are largely downstream-validated (expire:27, sources:82), so they are a code-smell, not the Critical driver — the empty-success shaping and decrypt-return-raw are. **Fix:** one shared error boundary that shapes failures as errors and routes caught server errors to `Sentry.captureException`. _(error-handling, M)_

### F-003 · Critical · A public-shipped static key gates a destructive mutation and bypasses rate limiting

`EXTENSION_API_KEY` gates the mutating `coupons/expire` route, is hardcoded in the public extension (`background.js:23`, sent on live calls), and is the rate-limit exemption in `rateLimit.ts:91`. **Why:** anyone who installs the extension can extract a value that both triggers a state change and removes its throttle — a concrete dangerous-default regression (reported concisely; not a re-architecture). **Fix:** the extension gets no privileged key; server-to-server mutations use a non-shipped secret; rate-limit exemption keys off an authenticated identity. _(security, S)_

### F-004 · High · No test suite — `pnpm test` is false-green

Root `test` → `turbo run test`, but no package defines `test`; both runs exit 0 with "No tasks were executed." App has only Playwright `test:e2e` (needs undocumented DB+migrations), extension a custom node script. **Why:** every fix here and every future change claims safety from a suite that runs zero lines — the #1 forced roadmap item and the prerequisite for safely touching F-006/F-007/F-008. **Fix:** real vitest suite wired into turbo `test` + CI; `test` fails when zero tests run; characterization tests first. _(testing, L)_

### F-005 · High · No validated env contract; `.env.example` stale (19 vs 38) and no fail-fast

38 distinct `process.env.*` reads; `.env.example` documents 19; ~11 undocumented (`COUPONS_DATABASE_URL`, `UPKUMA_HEALTH_SECRET`, …). Three missing-env strategies; `DATABASE_URL` port drifts 2345 vs 58005 across three files. **Why:** boot succeeds on a broken env and fails deep in a request; a docs-only engineer can't assemble one (proven in onboarding). **Fix:** one zod-validated env module imported at boot; regenerate `.env.example` from it; fail fast. _(operability, M)_

### F-006 · High · Coupon domain logic/constants have no single home (understated duplication)

The 7-status visibility predicate appears verbatim in ≥6 sites (coupons/route:48, sites/top-sites:13, sites/search-supported:24, coupons/stores:18 & :25, +marketing) and has **already drifted** into three definitions; the status→label map is re-declared in both app and extension; ranking `ORDER BY` duplicated. jscpd: 65 clones / 5.55% (also .tsx marketing/auth components). **Why:** the prime P1 dedup finding — a cold agent fixes one of six sites and ships a silent inconsistency. **Fix:** one coupon-domain module + a shared constants surface the extension consumes so app/extension can't drift. _(duplication, M)_

### F-007 · High · No shared request pipeline; cross-cutting concerns re-implemented or silently skipped

No `middleware.ts`; CORS hand-inlined 3× in one file (two copies bypass the local helper); rate-limit applied to some handlers and absent from others (oauth/authorize does crypto+secrets with no throttle); oauth/redirect hand-mints sessions via raw Prisma, bypassing better-auth. The wrappers that could centralize this are F-009's dead fossils. **Why:** no one way to gate a route → coverage gaps are invisible and permanent; the auth surface has two divergent implementations. **Fix:** one composable route wrapper (CORS+rate-limit+body-parse+auth); route oauth/redirect through better-auth. _(modularity, M)_

### F-008 · High · `shared-utils.js` is a 1536-line god-module (repo #1 churn AND #1 LOC); neighbour names mislead

Adversarial census: ≥8 unrelated responsibilities (DOM waits, price parsing, XPath utils, coupon-apply loop, modal UI, telemetry, messaging, storage). Highest churn (4529) and highest LOC in the repo. Navigation test predicted behaviors would live in `cart-signals.js`/`inject.js` — they're all in this monolith; the file names lie. **Why:** the most-edited file is the least context-holdable, and its neighbours misdirect. **Fix:** split along real responsibilities into honestly-named modules — **characterization tests (F-004) first**. Breaking for the extension; mind store-review lag. _(modularity, L)_

### F-009 · High · CI guardrails are blind and unenforced

Dead Pages-Router fossils (`cors.ts`, `initMiddleware.ts`, `middlewares/**` = withAuth/withRoles, `securityHelpers/apiResponse.ts`) with zero live callers are whitelisted in `knip.json`'s ignore list so the gate stays green while blind; neither `main` nor `dev` has branch protection (CI advisory only); vs the v5 baseline, **oxlint and size-limit are absent** and husky pre-commit lacks knip + prisma-drift. **Standoff caveat:** adversarial struck `apiResponseNext.ts` from the fossil set — it's live (used in `sources/route.ts`). **Why:** a passing gate lies about code health, a cold agent treats dead `withAuth` as the login helper, and nothing is enforced at merge. **Fix:** delete the fossils + `cors` dep and remove from knip ignore; enable branch protection; add oxlint + size-limit; extend husky. _(code_health, M)_

### F-010 · High · Onboarding docs are wrong/missing — docs-only boot fails

README has no getting-started and never links `LOCAL-DEV.md`; no doc says to create `apps/caramel-app/.env` or lists its secrets; `dev` generates the Prisma client but never applies migrations; the second DB is undocumented; app README is create-next-app boilerplate. **Why:** every new session is a freelancer's first day and the docs actively mislead (wrong port, missing DB/migration). Stage-4 codify target. **Fix:** rewrite README + LOCAL-DEV to the real path; delete boilerplate; validate with a fresh-agent onboarding trace. _(docs, M)_

### F-011 · High · Operability safety nets absent (runbook, deploy/rollback/smoke, error boundary, trace propagation)

No runbook/on-call/dashboard doc in 405 files; a `prisma migrate deploy` step exists but no app-deploy/rollback/smoke; no App-Router `error.tsx`; Sentry set to auto-create Vercel Cron Monitors on a Dokploy deploy (dead config); no trace ID propagated to the Python coupons service or the OpenRouter hop. **Why:** the 3am on-call has nowhere to look and nothing to roll back to; with F-001/F-002 a real outage is undiagnosable. **Fix:** RUNBOOK.md, App-Router error boundary, fix the Sentry cron config, propagate a trace ID across hops. _(operability, M)_

### F-012 · High · The LLM cart-classifier has no eval suite and no CI gate

The only user-facing LLM surface (`cartClassifier.ts` → `/api/classify-cart`, default `openai/gpt-5-mini`, env-swappable) has zero evals/scorers/CI/scoreboard; output validated by assertion, not schema. **Why:** per v5 §AI-quality it fails every bullet — a provider degrading the model or an env-pin drift is undetectable, and F-002 swallows the runtime failure too. **Fix:** install via `/ai-evals` (production prompt imported, deterministic scorers, PR+nightly+dispatch CI, eval-gated model changes). _(ai-quality, M)_

### F-013 · Medium · `any`-typed exported surfaces poison callers (~23 instances)

Live exported surfaces carry `any`: `decryptJsonData(resData:any):any`, `encryptJsonServer(payload:any)`, `apiResponseNext(metadata?:any,viewport?:any)`, 6 React-Select callbacks. **Why:** `any` on an exported boundary is contagious — callers lose safety exactly where a light model needs the type; tsc passes only because these hide mismatches. **Fix:** type exported surfaces first, then interior; lint against `any` on exports. _(typing, M)_

### F-014 · Medium · Dependency health degraded

Tool-sourced: 83 vulns (2 crit/45 high), 50/51 outdated (15 majors). Verified: `react-awesome-button` npm-deprecated; caret ranges throughout (v5 bans floating deps); nested `apps/caramel-app/pnpm-lock.yaml` duplicates the root. **Fix:** patch crit/high vulns, replace the deprecated dep, pin versions, single lockfile, CI audit gate. _(dependencies, M)_

### F-015 · Medium · Broken/stray artifacts ship and mislead

Firefox manifest lists `amazon.js` as a content script but the file doesn't exist (broken build shipped to Firefox); `verify_test_small3.txt` (committed Python error), a tracked `nul` file, app package misnamed `caramel-landing`, `.prettierrc.json` uses invalid key `tailwindConfigPath` (tailwind formatting silently never runs) — all 5 verbatim-verified. **Fix:** fix/remove the amazon.js ref, delete strays, rename the package, fix the prettier key; add root-file allowlist + manifest-integrity check. _(code_health, S)_

### F-016 · High · one-root-compose / dev-runs-prod-build rule violated (promoted P1)

Compose runs Postgres+Redis only ("Backing services only; apps run outside Docker"); `pnpm dev` runs framework hot-reload, not `docker compose up --build`; prod deploys via Nixpacks, not the compose. The exact opposite of v5 §Structure. **Why:** the rule calls this a P1 "never silently punch-listed" — local/CI/prod diverge and an AI agent sees behavior prod never runs. caramel is NOT in the PROD-GATE exception list. **Fix:** route via `/one-root-compose` (dedicated migration playbook) — large, breaking, separate initiative; sequence after the safety nets. _(architecture, L)_

> _Deviation note: this is the 16th finding, one over the 15-cap. Promoted deliberately from a rules-checklist GAP row because §Structure forbids appendixing a one-root-compose violation._

---

## Empirical results

- **Change-trace (coupling, measured):** expiry-badge **9/10** (1 file), lifetime-savings **3/10** (7 files; no user↔coupon-activity persistence exists; the only auth helper is dead), per-store success-rate **1/10** (9 in-repo files + a mandatory out-of-repo Python DB; ranking SQL already duplicated; a same-named `successRate` already means something else). Cross-cutting change is effectively unshippable without touching another repo.
- **3am incident:** 14 blind spots. A total coupons-DB outage is invisible three ways at once — health check green (wrong DB), users see "no coupons," Sentry silent. No runbook/rollback exists.
- **Onboarding:** app boots **partially** from docs (undocumented migration + second DB + port mismatch 58300 vs 58000); `pnpm test` is a false-green no-op; the one-line change _did_ pass the husky gates. 5 tribal-knowledge steps.
- **Name-only navigation:** behaviors **2/5** placed correctly (the two misses land in the `shared-utils.js` monolith behind modular-looking names); functions **10/10** — function naming is a genuine strength, file/module naming is not.
- **Pre-mortem:** 13 causal findings (3 Critical) converging on the same root as 3am — the external coupon DB read through untyped SQL with no health check and errors that never reach Sentry.

## Performance (P3 — order-of-magnitude only; none crowd P1–2)

No order-of-magnitude perf defects surfaced. Minor notes to appendix: the classify-cart 8KB cap reads only client `Content-Length` (DD1-5); `background.js` is the extension's single fetch chokepoint (DD2-8/CT-8). No action recommended this cycle.

---

## Roadmap (leverage-ordered; lead with the unlocking changes)

**Wave 1 — unlock everything else (do first):**

1. **F-004** test baseline _(L)_ — prerequisite for safely touching F-006/F-007/F-008. Nothing is safe until this exists.
2. **F-005** env contract + **F-009** guardrail stack _(M, M)_ — cheap, and they enforce every later rule; F-005 also unblocks reliable local/CI runs. _(F-009 deletes the dead wrappers F-007 will replace.)_

**Wave 2 — the operability spine:** 3. **F-002** error convention + **F-001** coupons-DB health/typed boundary _(M, M)_ — pair them; **F-011** runbook documents what they create. 4. **F-003** security regression _(S)_ — small, independent, do early. ⚠ breaking: rotates a key shipped in the extension — coordinate an extension release.

**Wave 3 — maintainability structure:** 5. **F-006** dedup coupon domain _(M)_. 6. **F-007** request pipeline _(M)_ — depends on F-009 (fossils gone), pairs with F-002. 7. **F-008** god-module split _(L)_ — depends on F-004. ⚠ breaking: extension refactor, mind store-review lag.

**Wave 4 — codify & cleanup (mechanical, parallelizable):** 8. **F-013** any-surfaces, **F-014** deps, **F-015** artifacts _(M/M/S)_. 9. **F-012** evals via `/ai-evals` _(M)_ — independent track. 10. **F-010** docs _(M)_ — LAST before Stage-4 codify, so docs describe the new reality.

**Separate initiative (own track):** 11. **F-016** one-root-compose via `/one-root-compose` _(L, breaking, prod-cutover)_ — do not fold into the above PRs.

**Inter-item dependencies:** F-008→F-004 · F-007→F-009 · F-006 benefits from F-004 · F-010 after all structural changes · F-011 after F-001/F-002.
**Breaking-change flags:** F-003 (key rotation + ext release), F-007 (route behavior), F-008 (ext refactor + store lag), F-016 (deploy pipeline), F-001 (contract layer).

## What's good — preserve

- **Strict TypeScript, green tsc** (0 errors) — keep it strict; F-013 closes the `any` holes without loosening.
- **Security architecture is sound** (accepted, not re-audited); **0 phantom CI secrets** (all 16 refs real — better than most audited repos).
- **Excellent function-level naming** (10/10 navigation) — the convention to keep; extend it to files/modules (F-008).
- **Sentry is wired** (`onRequestError`), Prisma migrations exist, husky pre-commit runs (lint-staged + type-check) — the foundation is there; F-002/F-009 make it actually catch things.
- **App/extension separation** and the read-only coupons-DB discipline (by comment) are the right instincts — F-001 just makes them explicit and monitored.

---

## Appendices

**A. Overflow findings (ranked, deferred to appendix)** — see `findings.json.appendix_overflow`: XOR-named-"encryption" (DD3-8), classifier dropped fields (DD1-3), Content-Length cap bypass (DD1-5), popup raw-enum UI leaks (DD1-8/9/10), domainRecord:null always (DD2-8), partial reinjection guards (DD2-9), build glob misses lockfile (DD2-12), extension eslint no preset (DD2-13), MV3 missing permission (DD2-14), constant-time-compare theater (DD3-2), 5 envelope shapes (DD3-5), 4 store-list endpoints (DD3-15), duplicate crypto helpers (DD4-3), 3 subfolder schemes (DD4-5), stale /increment comment (CT-5), successRate name collision (CT-7), free-text logging (AM-14), zero TODO markers (AIH-2).

**B. Unverified / parked:** none — all 15 elevated findings verified (F-016 promoted from the rules-checklist with direct compose+package.json evidence).

**C. Deletion count (hallucination meter): 0.** No candidate was deleted for an absent quote across the full pipeline.

**D. Rules-checklist:** `audit/rules-checklist.md` — 4 PASS / 29 VIOLATION / 5 N/A vs v5; 10 GAP rows, all now folded (STR-2→F-016, CIB-1/2/3+PIECE-1/7/8→F-009, ERR-2→F-011, AIH-1/2→appendix).

**E. Machine-readable:** `audit/findings.json` (for diffing future audits).
