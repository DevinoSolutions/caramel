# Testing

How the suites are laid out, how to run each one locally, and which quality
rules are enforced by a failing check. The authoritative suite map is
`DESIGN.md` §5 (Testing map) + §Gates; this file is the operational companion —
it stays in sync with that table.

## Suite map

| Suite             | Location                                         | Runner                                  | What it covers                                                                 |
| ----------------- | ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------ |
| App unit          | `apps/caramel-app/tests/unit/**/*.test.{ts,tsx}` | vitest (node env, jsdom per-file)       | env/schemas, `withRoute` pipeline, coupons repo/db, structural gates           |
| Extension unit    | `apps/caramel-extension/tests/*.mjs`             | vitest + jsdom (`_load.mjs` harness)    | content-script + popup + background behavior in one shared realm               |
| Integration       | `apps/caramel-app/tests/integration/*.itest.ts`  | vitest (`vitest.integration.config.ts`) | coupon reads/writes, ingest, bridge sync + signals against a real app Postgres |
| E2E               | `apps/caramel-app/e2e/*.spec.ts`                 | Playwright (chromium)                   | public pages, auth flows, extension-smoke, Argos visual regression             |
| Eval (LIVE, paid) | `apps/caramel-app/evals/**/*.eval.ts`            | vitest (`vitest.eval.config.ts`)        | cart-classifier against the LIVE model + production prompt                     |

## Running locally

```bash
# Unit — app + extension (turbo). `--force` bypasses the turbo cache.
pnpm test
pnpm test --force
# One app unit file:
pnpm --filter caramel-app exec vitest run tests/unit/<file>.test.ts

# E2E — needs local Postgres up + migrations applied first:
#   docker compose up postgres -d && pnpm --filter caramel-app db:migrate:deploy
pnpm --filter caramel-app test:e2e

# Integration — coupon reads/writes, ingest + bridge sync against a real app
# Postgres. Needs local Postgres up + migrations applied first:
#   docker compose up postgres -d && pnpm --filter caramel-app db:migrate:deploy
pnpm --filter caramel-app test:integration

# Eval — LIVE OpenRouter calls, COSTS REAL MONEY. Needs OPENROUTER_API_KEY in
# apps/caramel-app/.env (loaded via Node's process.loadEnvFile). Red-proof
# variant (8 cases, still live): SCRAMBLE_EVAL=1 ... eval
pnpm --filter caramel-app eval
```

## Quality rules → enforcing check

Rules that matter carry a check that fails the build (CLAUDE.md "rules become
checks"), not just a note:

| Rule                                                          | Enforced by                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| No `.only(` in any suite (it silently narrows a green run)    | `tests/unit/test-quality-guardrails.test.ts` (static) + Playwright `forbidOnly` (e2e CI) |
| No wall-clock sleeps in e2e (`waitForTimeout` / `setTimeout`) | `tests/unit/test-quality-guardrails.test.ts` — e2e specs wait on state, not the clock    |
| Eval `*.eval.ts` files never collected by the unit runner     | `tests/unit/eval-files-out-of-unit-glob.test.ts` + `vitest.config.ts` `exclude`          |
| Behavior-driven `describe`/`it` names (read as a spec line)   | convention (code review) — the existing suites model it                                  |
| Mocks announce themselves (a header/comment naming the mock)  | convention (code review); see e.g. `tests/unit/rateLimit.test.ts`                        |

Structural gates share the same fs-walk style and also live in
`tests/unit/`: `api-routes-use-withRoute.test.ts`, `prisma-schema-secrecy.test.ts`,
`no-raw-coupon-status.test.ts`, `repo-integrity.test.ts`.

## Local-run gotchas (repo truths)

- **E2E workers/retries.** `playwright.config.ts` applies `workers: 1,
retries: 2` and `forbidOnly` only under CI; locally it defaults to parallel
  workers + 0 retries and boots `pnpm dev` (reused if already running). For a
  stable run against a cold dev server, pass `--workers=1 --retries=2`.
- **E2E runs in TWO contexts — write specs for both.** `e2e-pr`/local is
  _hermetic_: a fresh Postgres, `prisma migrate deploy` + the synthetic
  `catalog_seed`, seedable users, `DATABASE_URL` set. `e2e-push` runs the SAME
  specs against the _deployed_ dev site: NO `DATABASE_URL`, no generated prisma
  client, REAL catalog data. Collection happens in BOTH. So any spec that
  asserts specific DB content or touches the DB MUST gate itself on
  `test.skip(!process.env.DATABASE_URL, …)` AND must never import the generated
  Prisma client at module top level (open it with `openTestPrisma()` from
  `e2e/support/test-prisma.ts`, which imports lazily, or the whole file crashes
  collection on `e2e-push`). Deployment-safe assertions
  (page shell, generic content presence) stay ungated so they cover pushes too.
  Live examples: `e2e/auth-flows.spec.ts` ("Login (real session)" group) and
  the lazy-import comment in `e2e/support/test-prisma.ts`. Two e2e-push reds were
  caused by breaking exactly this rule (a top-level prisma import; a synthetic
  seed row asserted against the real deployed catalog).
- **App-owned coupon catalog.** `pnpm dev` (and `db:migrate:deploy`) creates and
  seeds the catalog, so coupon routes return `200` and `/api/health/db` reports
  `catalog: "ok"` locally — the pre-inversion "degraded mode" is retired.
- **Windows EOL.** The byte-exact generated-constants test breaks on a fresh
  clone with `core.autocrlf=true` — run `git config core.autocrlf false` and
  re-checkout (no `.gitattributes` yet, NF-04).
- **`server-only` under vitest.** It throws in the test runtime; shimmed once
  in `tests/setup.ts`.
- **Unit env.** `vitest.config.ts` injects dummy values for `DATABASE_URL` and
  `BETTER_AUTH_SECRET` (the required boot vars) plus a now-optional
  `COUPONS_DATABASE_URL`, so `env.ts`'s boot-time parse doesn't throw before any
  assertion runs.
- **Eval budget.** `openai/gpt-5-mini` is a reasoning model — its completion
  budget already accounts for hidden reasoning tokens (F-017); don't trim it.
