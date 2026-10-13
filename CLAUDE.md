# Shared Engineering Rules (Devino — all projects)

<!-- v5 · 2026-07-10 · CANONICAL HOME: ~/.claude/skills/codebase-audit/references/shared-claude-rules.md — THE single source of truth; edit HERE only. -->

## Errors & visibility

- No silent failures: never `except: pass` / swallowed catch / catch-and-continue. Errors throw loudly with Sentry-usable context (right params, meaningful messages).
- One trace/request ID flows end-to-end across every hop (Next.js → iii worker → Python/JS/Rust script) via Sentry distributed tracing / OTel headers.
- No fire-and-forget: async/background work returns success/failure and callers check it; a failure that never surfaces is a defect.

## Typing & contracts

- Strict TypeScript: no `any`, no lazy inference on exported surfaces. Python gets ruff + ty even for small helper scripts.
- `.env` is zod-validated before boot; `.env.example` is the vocabulary. Boot must fail fast on a bad env, not debug-loop at runtime.
- Producer and consumer share one schema: if the consumer (e.g. iii) validates with zod, the producer (e.g. Next.js) must use the same contract — drift fails statically or in CI, never only at runtime.
- Pinned versions everywhere: no `@latest`, lockfile committed and enforced; the SDK version in the app must match what infra actually hosts (CI check, or one compose owning all services).

## Structure

- (monorepos) Landing page + main app share one UI package for the big shared elements (animations, logos, hero components) — duplicating them across apps is a finding.
- One root `docker-compose.yml` is the real service graph (local, CI, prod); `pnpm dev` is `docker compose up --build`, never framework dev mode; a missing/broken root compose is a P1 finding; migrating a deployed app onto compose means verified backups, then a dark bring-up before any traffic moves. Full rule text and the /one-root-compose skill pointer: `docs/agent/engineering-rules.md`.
    - **PROD GATE EXCEPTION (Aladdin 2026-07-10): uNotes, Shorty, GetItDone — never touch production without the user's explicit in-session confirmation.** Run Phases 0–3 fully, stand the stack up in the project's Dokploy DEV environment (dark), report, and STOP: no prod domain moves, no stopping prod apps, no prod data writes until the user manually says go. Projects not listed (e.g. BioFlow, Postify) follow the standard full flow.

## AI-session hygiene

- Names are non-ambiguous: a schema/var/function name tells an agent what it does without digging through other files (use graphify to see the coupling and pick the honest name).
- Every new session/compact is a freelancer's first day. Unfinished work carries loud `TODO:`/limitation markers in the code itself — an unmarked incomplete module is a defect, because the next agent will build on it as if production-ready.
- A repo holds only tracked, current files. Loose freeform artifacts (scratch notes, pasted chats, ad-hoc `.txt`/`.md`, junk files) are context hazards — a fresh session can't tell a fossil from live tasking and may act on one. Ephemeral notes live in the task system or a gitignored scratch dir, never loose in the repo; once a note is consumed, date it, archive it, delete the original. Check: root-file allowlist gate in CI (`TODO:` where not yet wired).
- Mocks must announce themselves (naming, comment, TODO). A mocked result an agent can mistake for a real implementation is a defect — E2E tests that "miraculously pass fast" are the classic symptom.
- No trial-and-error layering ("try A, else B, else C"): dead branches and redundant guards left from iteration get removed before commit.
- Confidence only when verified: never claim something works without an end-to-end check (Stealth/Chrome DevTools for UI, a real run for jobs). An unverified "it works" poisons every later decision in the session.
- Fetch current docs (context7) before coding against any library — training-data versions lie.
- Before adding a feature, check the knowledge graph (graphify) for existing logic: reuse and integrate; duplicating an existing concept is a defect.
- A green suite doesn't mean your change is safe — it proves only the paths it runs, and big files often have the least coverage. Before rewriting a file, confirm the suite exercises it; if not, pin current behavior first (characterization tests).

## Rules become checks

- Every rule that matters gets a check that fails the build: lint rule, import ban (`no-restricted-imports` / module-boundary rule), CI grep gate, schema-drift workflow, knip. A rule that lives only in this file will be forgotten by the next session. When adding a rule here, add its enforcement — or an explicit `TODO:` naming the missing check.
- Ban the raw form the moment a shared helper exists (`no-restricted-syntax` / `no-restricted-imports`). Suppressions (`eslint-disable`, `@ts-expect-error`, `# noqa`) carry a dated reason or the PR is blocked.

## AI quality (evals)

- Every user-facing LLM surface has an eval suite (live production model + prompts, programmatic scorers, threshold gate) that runs in CI (PR path-filtered + nightly); model/prompt changes are eval-gated (green twice + a dated scoreboard row); CI secrets must be verified to exist. Full text: `docs/agent/engineering-rules.md`.
- Real production AI failures become eval cases before (or with) the fix.

## Product & priorities (audit/refactor-time lens)

- Quick wins first: any high-value low-effort feature is a finding too — during audits/refactors, check competitors' Reddit + GitHub issues for what users are asking for that we can add easily.

## CI baseline (target stack — adopt per project as the build allows)

- oxlint (+ the few eslint rules it doesn't cover) · prettier (until oxfmt stabilizes) · strict `tsc` · ruff + ty (path-filtered to Python, incl. iii functions) · knip · prisma schema-drift check (where Prisma exists) · size-limit (bundle-sensitive libs only).
- Husky pre-commit mirrors the cheap gates locally — tsc, knip, oxlint, prettier (+ the prisma check, semi-lightweight) — so agents catch violations at commit time instead of round-tripping the gh CLI to discover CI failed.
- Once proper build steps pass in CI: playwright + vitest · Lighthouse CI (landing/critical pages) · Snapvisor visual regression.

<!-- End shared block — project-specific commands, architecture, conventions, and gotchas follow. -->

# caramel — project specifics (audit cycle 1, 2026-07-11; sources: DESIGN.md + `audit/` internal archive, gitignored — present only on maintainer machines)

## Commands

- Setup: `pnpm install` → `cp apps/caramel-app/.env.example apps/caramel-app/.env` (secrets table in README) → `pnpm dev` (F-016 one-root-compose: `docker compose up --build` builds web, boots pg :58005, runs `prisma migrate deploy` in-container).
- Run: `pnpm dev` (docker compose up --build → app :58000; one root compose = local/CI/prod graph, hot reload traded away 2026-07-09) · host escape hatches (need `docker compose up postgres -d` first): `pnpm dev:next` (app :58000 with hot reload), `pnpm dev:extension` (web-ext). See docs/LOCAL-DEV.md.
- Test: `pnpm test` (turbo → vitest: app `tests/unit/**/*.test.{ts,tsx}` + extension `tests/*.mjs`) · single file: `pnpm --filter caramel-app exec vitest run tests/unit/<file>` · e2e: `pnpm --filter caramel-app test:e2e` (needs DB+migrations) · evals (live LLM, costs money): `pnpm --filter caramel-app eval` (needs `OPENROUTER_API_KEY`).
- Gates (all also run in husky pre-commit + CI): `pnpm lint` · `pnpm lint:oxlint` · `pnpm prettier-check` · `pnpm --filter caramel-app knip` · `pnpm -r run type-check`. Ops: `pnpm --filter caramel-app smoke`, `... test:integration` (needs local pg), `... bridge:sync` (migration-period external→app catalog feed; needs `COUPONS_DATABASE_URL`) — see RUNBOOK.md.

## Architecture (10 lines)

- pnpm@9 monorepo, two packages. `apps/caramel-app` = Next.js 16 App Router + Prisma → ONE Postgres (`DATABASE_URL`) holding auth/user AND the app-OWNED coupon catalog; reads run via `prisma.$queryRaw` in `src/lib/couponsRepo.ts` (zod row schemas in `src/lib/couponsDb.ts`); the sanctioned catalog writes are listed under Hard boundaries. `apps/caramel-extension` = MV3 built with WXT (`entrypoints/content.ts` composes the content realm by calling each module's `init*`; popup is React; `cartClassifier.ts` → `/api/classify-cart` is the eval-gated LLM surface). Deploys: Dokploy → grabcaramel.com; the root `docker-compose.yml` is the intended deployment unit (prod cutover stays gated + human-run). Full architecture paragraphs: `docs/agent/architecture.md`.
- All env access via `src/lib/env.ts` / `env.client.ts` (zod, boot fail-fast via instrumentation.ts). Every API route declares itself through `src/lib/api/withRoute.ts` (CORS/rate-limit/origin/bearer/zod-body/OPTIONS) and errors through `handleRouteError` → Sentry. Coupon domain vocabulary/predicates live ONLY in `src/lib/coupons.ts` (+ the `Prisma.sql` fragment factories in couponsRepo.ts).
- Extension OAuth session mint: `src/lib/auth/extensionOAuthSession.ts` (one module, deliberately not better-auth — see DESIGN.md).

## Conventions in force → their enforcing check

Every convention here has an enforcing check. The full convention → check map (deps pinning, no `any`, raw coupon-status ban, generated extension constants, root-file allowlist, extension size budgets and design tokens, eval gate, coupons-SQL-only-in-couponsRepo, prisma schema secrecy, manifest parity, e2e contexts) is in `docs/agent/conventions-and-checks.md` — read it before touching those areas. The rules that bite most:

- Generated extension constants are byte-synced and NEVER hand-edited: regenerate via `pnpm --filter caramel-app generate:coupon-constants`.
- Coupons SQL lives only in `src/lib/couponsRepo.ts` (never inline in a route/page); raw coupon-status literals are banned outside `coupons.ts`/the generated file; the scraper's PIPELINE-INTERNAL tables stay out of `prisma/schema.prisma`.
- The e2e suite runs hermetic (`DATABASE_URL` set) AND deployed (no `DATABASE_URL`, no generated prisma client): any spec asserting DB content or touching the DB MUST gate on `test.skip(!process.env.DATABASE_URL, …)` and MUST NOT import `@prisma/client` at module top level.
- Model/prompt changes need `pnpm eval` green ×2 + a dated `evals/SCOREBOARD.md` row (eval gate ≥0.85 primary-match).
- Unenforced (memory only): new routes must use `withRoute`; env reads only via the env modules; new `.eval.ts` stays out of the unit glob.

## Gotchas (each cost a real debugging round)

- Coupon-read tests mock `@/lib/prisma` and assert on the composed `.sql` string — read the header in `tests/unit/coupons-visibility.test.ts` / `couponsRepo.test.ts` before touching such mocks (details: `docs/agent/gotchas.md`).
- `.gitattributes` pins `eol=lf` (NF-04) so fresh clones are safe, but a clone predating it with `core.autocrlf=true` breaks the byte-exact generated-file test — `git config core.autocrlf false && git checkout-index -a -f` (`git reset --hard` won't rewrite round-trip-clean files; docs/LOCAL-DEV.md troubleshooting).
- `openai/gpt-5-mini` is a REASONING model: completion budget must include hidden reasoning tokens (`maxTokens: 600`, see F-017 in `evals/SCOREBOARD.md`) — never trim it back to "just enough JSON".
- Extension env stamp: `CARAMEL_ENV` comes from `import`ing `caramel-env.js`; never decide dev-vs-production at runtime from the manifest; keep new extension modules free of top-level side effects and wire any effect through an `init*` called from `entrypoints/content.ts` (details: `docs/agent/gotchas.md`).
- `server-only` throws under vitest — shimmed once in `tests/setup.ts`. `.env*` is gitignored — a new shareable env-named file needs a `!` negation entry (`.env.example` burned us).
- The Docker build step MUST stay `pnpm --filter caramel-app run build`, NEVER `turbo run build` (turbo's strict env mode strips the build-time env before `next build` sees it) (details: `docs/agent/gotchas.md`).

## Hard boundaries (never without explicit human direction)

- Never push to or merge into `dev`/`main`; audit PRs are merged by humans only. Never mutate GitHub repo settings.
- The app OWNS the coupon catalog (`DATABASE_URL`): the ONE sanctioned supplier write path is `POST /api/ingest/catalog` (`applyCatalogRows`, tombstone-gated); the app's own sanctioned writes are `expireCoupons` + `requestSource` + `submitShopperCoupon` (owner-directed 2026-10-02; shopper-submitted codes, see DESIGN.md §2(l′)) (usage moved to `coupon_signals.recordUsage`, NOT the catalog — `incrementCouponUsage` retired). The EXTERNAL `caramel_coupons` DB stays strictly read-only — SELECT-only, via the migration-period `bridge:sync` only. Don't add other write paths to either.
- Don't change the extension's build system (WXT + the build-time env stamp) without explicit human direction, don't re-flag the deliberate designs listed in DESIGN.md §standoffs. F-016 one-root-compose landed the root `docker-compose.yml` (`pnpm dev`) for local/CI; the prod cutover onto it stays gated and human-run (never touch prod without explicit in-session confirmation).

## More detail (moved verbatim out of this file; read when the task touches that area)

- `docs/agent/engineering-rules.md` — shared-rules header/version history, the full one-root-compose rule (playbook pointer, migration order), and the full AI-evals rules.
- `docs/agent/architecture.md` — full architecture paragraphs: catalog ownership/ingest/reads, the WXT extension layout, deploys, health endpoint, `coupon_signals`.
- `docs/agent/conventions-and-checks.md` — the complete convention → enforcing-check map (test file or CI job per rule, size budgets, parity harness, e2e contexts).
- `docs/agent/gotchas.md` — long-form gotchas: coupon-read test mocks, extension env stamp, in-image Docker build traps.
