# PLAN-F-011 — Operability safety nets: RUNBOOK, App-Router error boundary, dead Sentry config, cross-hop trace correlation

**Finding:** F-011 (High, operability) · **Effort:** M · **Wave 2, sequence 7 (last of W2)** · **Depends-on:** F-004 (vitest infra), F-001 (coupons-DB health check + typed read layer), F-002 (shared error handler + Sentry.captureException), F-005 (zod env + regenerated `.env.example`). Plan assumes all four have LANDED.

## Executive summary

Add the operability layer the 3am walkthrough proved absent: a repo-root `RUNBOOK.md`, an App-Router error boundary (`error.tsx` + `global-error.tsx` with Sentry capture + branded honest UI), removal of dead `automaticVercelMonitors`, coarse cross-hop correlation (OpenRouter generation-id on the Sentry span; `application_name` on the coupons `postgres` client), and a callable post-deploy smoke script. ~10 files (5 new, ~4 edits + tests). **Breaking: NO** (all additive or dead-config removal). Riskiest step: `global-error.tsx` must never itself throw (last-resort boundary) — keep it dependency-free.

## Premise corrections (verified in code)

- Lead brief says "couponsDb **pg Pool**". FALSE: `src/lib/couponsDb.ts:7,21` uses the **porsager `postgres`** client (`postgres@^3.4.9`), not `pg`/`Pool`. `application_name` is set via the `connection` option (`postgres(url, { connection: { application_name } })`) or a `?application_name=` DSN param — **not** `pool` config. Executor must verify the option name against porsager types at fix time.
- Sentry is initialized **production-only** (`sentry.common.config.ts:8`, `next.config.mjs:48`). So `Sentry.getActiveSpan()` is a no-op in dev/test — all span-attribute writes MUST be optional-chained. The OpenRouter fetch already runs inside a traced route handler (`api/classify-cart/route.ts` → `classifyCart` → `chat`), so an auto `http.client` span already exists in prod; **do not hand-roll a span** — verify @sentry/nextjs auto-fetch-instrumentation via context7 first, only wrap if absent.
- All else verified true: `automaticVercelMonitors: true` at `next.config.mjs:57`; no `error.tsx`/`global-error.tsx` anywhere (glob); single health route `/api/health/db` gated by `Bearer $UPKUMA_HEALTH_SECRET`; README CI/CD is the 3-line stub (70-72); `scripts/` + `tsx` is the established script convention (`scripts/ci-env.ts`).

## Scope

**Create:** `RUNBOOK.md` (repo root) · `apps/caramel-app/src/app/error.tsx` · `apps/caramel-app/src/app/global-error.tsx` · `apps/caramel-app/scripts/smoke.ts` · tests (see §Test).
**Modify:** `apps/caramel-app/next.config.mjs` (delete line 57) · `apps/caramel-app/src/lib/openrouter.ts` (correlation id header + span attrs) · `apps/caramel-app/src/lib/couponsDb.ts` (add `connection.application_name`) · `apps/caramel-app/package.json` (`"smoke"` script) · `README.md` (one-line RUNBOOK pointer — SHOULD; overlaps F-010, flagged below).
**Out of scope (name as future findings, do NOT touch):** F-016 one-root-compose / Dockerfiles; alerting/paging/dashboard _creation_; wiring smoke into the Dokploy pipeline (human/ops handoff — document the command only); `not-found.tsx`; extension-side telemetry & false-empty UI (AM-6/7/8); app-wide structured logging + request-id (AM-14 → F-002/future); health-secret rotation automation (AM-11); provisioning `COUPONS_DATABASE_URL` locally (AM-4 → F-001/F-005); full OTel across the Postgres/Python boundary (name as known debt in RUNBOOK).

## Approach

- **RUNBOOK.md at repo root** (not in `docs/`) so a cold on-call greps it first; README points at it. Content = system map + log/dashboard locations + health checks + rollback + documentable failure modes + trace-correlation notes + schema-drift check. Unknowns (exact Dokploy app/project name, Sentry monitor owning `UPKUMA_HEALTH_SECRET`) are written as explicit **`TODO(human):`** lines — never invented. Rejected: burying ops in README (F-010 owns README; discoverability wants a dedicated file).
- **Error boundary:** canonical Next pattern — `'use client'`, `useEffect(() => Sentry.captureException(error), [error])`, `reset` button, branded honest copy. `error.tsx` renders inside root layout (Tailwind brand tokens `bg-caramel` / `dark:bg-darkBg` already in `globals.css` + store page — reuse, no new design). `global-error.tsx` REPLACES root layout → own `<html><body>`, inline/utility styles only, **no Providers/data deps**. Rejected: a shared error component imported by both — global-error must stay self-contained to survive a broken layout.
- **Dead Sentry config:** delete `automaticVercelMonitors: true` (Dokploy deploy, no Vercel crons — dead). Confirmed exact option name in code.
- **Trace correlation (honest, coarse):** (a) OpenRouter — Sentry already spans the fetch + propagates `sentry-trace`/`baggage` (server default); OpenRouter ignores those, so the useful add is capturing the **response `id` (generation id, visible in OpenRouter's dashboard)** onto the active span + attaching our own `X-Request-Id` for our-log correlation. Do NOT duplicate the auto span. F-002 already routes the caught error to Sentry — do NOT add a second `captureException`. (b) Postgres hop has **no header channel** — set `application_name: 'caramel-app'` on the `postgres` client so coupons queries are attributable in `pg_stat_activity`/DB logs. RUNBOOK states plainly: cross-hop correlation here is coarse (application_name + timing), not per-request; full OTel = known debt.
- **Smoke script:** `scripts/smoke.ts` (run via `tsx`, matching `ci-env.ts`), `BASE_URL`+`UPKUMA_HEALTH_SECRET` from env, hits `/` (200/html), `/api/health/db` (200 + every reported service `status==='ok'`, sending the Bearer header), `/api/coupons?site=amazon.com` (200 + array/`{coupons}` shape); prints per-check PASS/FAIL, exits non-zero on first failure. Shape assertions read the **actual post-F-001 health JSON** from the landed route (do not guess F-001's multi-service shape).

## Sequencing (each step ends with its check)

1. **Pins first (F-004 infra).** Characterization tests BEFORE edits: `openrouter.test.ts` (mock global `fetch`: pins URL/POST/`Authorization`+`HTTP-Referer`+`X-Title`/body, returns content, throws `OpenRouterError` on `!ok` & empty); `couponsDb.test.ts` (mock `postgres` default export: pins current options `{max:10,idle_timeout:20,connect_timeout:10,prepare:false}`). ✓ `pnpm --filter caramel-landing test` green on new tests.
2. **RUNBOOK.md** authored (structure in §Approach; TODO(human) for unknowns; read the LANDED F-001 health route + F-001 schema-drift script path + F-002 helper name to describe them accurately). ✓ every URL/path/env-var referenced exists in repo (or is a marked TODO); no invented Dokploy names.
3. **error.tsx + global-error.tsx** created. ✓ new render+capture tests green (§Test); `tsc --noEmit` green.
4. **next.config.mjs:57** removed. ✓ `next build` green; grep confirms `automaticVercelMonitors` gone.
5. **openrouter.ts** trace change (after context7 confirms auto-instrumentation): add `X-Request-Id` header + optional-chained `getActiveSpan()?.setAttributes({...generation_id, request_id})`; extend pin test to assert header present + Sentry span setter called (mocked). ✓ updated `openrouter.test.ts` green.
6. **couponsDb.ts** add `connection: { application_name: 'caramel-app' }`. ✓ updated `couponsDb.test.ts` asserts option now present; `tsc` green.
7. **smoke.ts** + `smoke.test.ts` (unit on shape helpers, green+red) + `"smoke"` script in package.json. ✓ helper unit tests green; smoke runs green against a local `next dev` boot for `/` + reachable health (coupons check exercised where env is provisioned — see §Test).
8. **README** one-line pointer to RUNBOOK. ✓ `prettier-check` green. (Flag F-010 overlap in PR.)

## Breaking changes

None. `automaticVercelMonitors` removal is behavior-neutral on Dokploy (it only registered Vercel crons that never existed). `error.tsx`/`global-error.tsx` add boundaries where none existed → uncaught render throws go from Next's default page to branded UI (strict improvement). `application_name` is an additive connection param; `X-Request-Id` is a header OpenRouter ignores if unused — request/response contracts unchanged. Smoke script has no runtime consumer. No API/route/DB contract changes; no consumer coordination needed.

## Test strategy

- **Pinning (step 1, BEFORE edits):** `openrouter.test.ts`, `couponsDb.test.ts` — pin the current contracts so the trace/`application_name` edits provably don't regress them.
- **New behavior:** `error.test.tsx` — render via React Testing Library (effects run) asserting the honest message renders, `Sentry.captureException(error)` called (mock `@sentry/nextjs`), `reset` invoked on button click. `global-error.tsx` — `renderToStaticMarkup` structure assertion (identical useEffect-capture pattern verified once in error.test.tsx). **Dep note:** prefer F-004's DOM/RTL setup; if F-004's baseline is node-only, add `@testing-library/react` + `jsdom` (or `happy-dom`) as caramel-app **test-only devDeps** in this commit (the sole new-dep risk — flag in PR). `smoke.test.ts` pins the pure `assertOk`/`assertShape` helpers green AND red (no live server).
- **Green meaning:** at each checkpoint = the new/updated vitest tests for the touched file pass under F-004 infra + `tsc --noEmit` + (step 4) `next build`. Local-boot smoke green = `/` + reachable health; the coupons-endpoint assertion is validated where `COUPONS_DATABASE_URL` is set (dev), not asserted locally (documented limitation, AM-4). **RUNBOOK accuracy is validated by the Stage-3 3am empirical re-run** — a fresh Haiku must be able to follow it end-to-end.

## Rollback

Single commit `fix(F-011): operability runbook, error boundary, trace correlation, smoke`. Internal checkpoints at each numbered step (commit locally per step so a failed step restarts without losing pins; squash to one before PR). Safe revert = `git revert <sha>`: all changes are additive except a one-line config deletion and two small, test-pinned lib edits — no data/schema/migration involved, clean revert.

## Risk

Low blast radius; all edits are prod-observability/ops or net-new files. **Worst case:** `global-error.tsx` throws during a real incident (recursive failure) — mitigated by keeping it dependency-free (no Providers, no fetch, inline styles). **Watch:** (1) `@sentry/nextjs` import lands only in server code (`openrouter.ts` is server-only) — must not enter a client bundle; (2) wrong porsager option name silently ignored — verify against types, smoke/health catches a bad connection; (3) F-001/F-002 landed shapes differ from assumption — mitigated by having the executor READ the landed routes/helpers rather than guess. **Premises:** verified-in-code — the `pg Pool` mislabel, prod-only Sentry, the dead config line, absent error boundaries, single auth-only health route, and the `scripts/`+`tsx` convention. **Assumed (executor verifies at fix time):** @sentry/nextjs auto-fetch-instrumentation (context7), porsager `connection.application_name` (types), F-001 health JSON shape + schema-drift script path, F-002 helper identity, F-004 DOM test env.
