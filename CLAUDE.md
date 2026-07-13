# Shared Engineering Rules (Devino — all projects)

<!-- v5 · 2026-07-10 · CANONICAL HOME: ~/.claude/skills/codebase-audit/references/shared-claude-rules.md — THE single source of truth; edit HERE only. -->
<!-- source: Amin+Aladdin eng discussion 2026-07-04→07 (devinorules.txt) + shorty audit cycle 1 + Amin+Aladdin Discord 2026-07-09 (one-compose / dev-runs-prod-build) + shorty AI-evals build 2026-07-09 (Amin: evals "part of the CI/CD pipelines… treat it like maintaining it like playwright"). -->
<!-- consumed by exactly TWO skills, no other copies anywhere: (1) codebase-audit — grades against this file; Stage 4 embeds this block at the top of the project CLAUDE.md (keep this header), project specifics BELOW it; (2) devino-codebases — reads this file fresh at run start and codifies into the project CLAUDE.md the same way. Project CLAUDE.md embeds are version-stamped OUTPUTS, re-synced on the next audit/codify/devino-codebases touch — never edited by hand, never canonical. The /ai-evals skill BUILDS what §"AI quality (evals)" demands; these two skills only grade/verify against it. -->
<!-- v2 changes vs v1 (2026-07-06): added non-ambiguous naming, monorepo shared-UI, suppression/raw-form check examples, quick-wins lens. All other rule content verbatim v1. -->
<!-- v3 changes vs v2 (2026-07-09): added one-root-compose + dev-runs-prod-build rule under Structure (Amin: "pnpm dev just runs docker compose up --build" — identical local/prod behavior for AI agents beats hot reload; applies to Postify, uNotes, GetItDone, Shorty). All other rule content verbatim v2. -->
<!-- v4 changes vs v3 (2026-07-09): added §"AI quality (evals)" (shorty PR #217: eval suites on Mastra runEvals, ai-evals.yml CI wiring, eval-gated model sweep gpt-4o→5.4 / gemini-2.5→3.1; proving red-check demo PR #219). All other rule content verbatim v3. -->
<!-- v5 changes vs v4 (2026-07-10, after the BioFlow prod migration): one-root-compose clarified to the LITERAL reading (prod runs the same compose file as ONE platform compose service, not merely the same Dockerfiles across separate apps); PROD-GATE exception added for uNotes/Shorty/GetItDone (dev environment only until Aladdin manually confirms prod in-session); migration playbook + Dokploy gotchas live in the /one-root-compose skill (which supersedes ~/.claude/prompts/compose-parity.md). All other rule content verbatim v4. -->

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
- ONE root docker-compose runs the real service graph (web, workers, sidecars, DB) with prod-mode builds — local, CI, and prod are the same graph, and "same" is LITERAL: production runs this exact file as ONE platform compose service (Dokploy compose, github-sourced, autodeploy on push), not merely the same Dockerfiles across separate apps (ratified during the BioFlow migration 2026-07-10). The dev command (`pnpm dev`) is `docker compose up --build`, NOT framework dev mode: hot reload is deliberately traded away so agents see identical behavior locally and in prod (Amin+Aladdin 2026-07-09). A missing/broken root compose is a P1 finding, never silently punch-listed. Migrating a deployed app onto compose = backups first (VERIFY they restore), then dark bring-up (stack deployed with NO domains + autodeploy OFF, data restored, storage mirrored, internally smoked) BEFORE any traffic moves — the full proven playbook + platform gotchas (unique network aliases / isolatedDeployment, stale traefik file-provider routers, env-writer quirks, autodeploy webhook races, platform-native backups) is the **/one-root-compose skill** (~/.claude/skills/one-root-compose/SKILL.md — supersedes ~/.claude/prompts/compose-parity.md): follow it, don't rediscover it. Check: gates script asserts root compose exists + service set matches prod + `dev` script shape (`TODO:` where not yet wired).
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

- Every user-facing LLM surface (chat, agent, summarizer, generation) has an eval suite: fixed dataset → the LIVE production model + prompts → programmatic scorers → pass-rate threshold gate. Suites import the production prompts/schemas/tools — a copied prompt drifts silently and is a finding. Deterministic check-scorers first; LLM-as-judge only where a rule genuinely can't be crisp. Eval files stay out of the unit-test glob (live calls cost money — `.eval.ts` suffix / not `test_*.py`).
- Evals run in CI as a standing, permanently maintained gate: PR-triggered on AI-touching paths (path-filtered so unrelated PRs never pay or see a stochastic red), nightly against live models with an auto-opened issue on failure (the only thing that catches a provider changing a model with zero code change), plus manual dispatch for model work. Evals that exist but only run locally are a finding.
- Model changes are eval-gated: suite green TWICE + a dated scoreboard row (result, price, latency) before the swap ships; keep one regression proof on record (the rejected/old model measurably failing the suite — the evidence the gate works). At every swap, audit deploy-time model pins (host env like `CHAT_MODEL`) against code defaults — a stale pin silently overrides the code.
- Real production AI failures become eval cases before (or with) the fix.
- CI secrets are verified to EXIST (`gh secret list`) — workflow `secrets.*` references resolve to empty strings when unset, silently, and nothing fails until something actually consumes them. Check: ai-evals workflow present + its path filter matches the repo's actual AI surfaces (`TODO:` where not yet wired).

## Product & priorities (audit/refactor-time lens)

- Quick wins first: any high-value low-effort feature is a finding too — during audits/refactors, check competitors' Reddit + GitHub issues for what users are asking for that we can add easily.

## CI baseline (target stack — adopt per project as the build allows)

- oxlint (+ the few eslint rules it doesn't cover) · prettier (until oxfmt stabilizes) · strict `tsc` · ruff + ty (path-filtered to Python, incl. iii functions) · knip · prisma schema-drift check (where Prisma exists) · size-limit (bundle-sensitive libs only).
- Husky pre-commit mirrors the cheap gates locally — tsc, knip, oxlint, prettier (+ the prisma check, semi-lightweight) — so agents catch violations at commit time instead of round-tripping the gh CLI to discover CI failed.
- Once proper build steps pass in CI: playwright + vitest · Lighthouse CI (landing/critical pages) · Snapvisor visual regression.

<!-- End shared block — project-specific commands, architecture, conventions, and gotchas follow. -->

# caramel — project specifics (audit cycle 1, 2026-07-11; sources: audit/stage3-results.md, DESIGN.md)

## Commands

- Setup: `pnpm install` → `cp apps/caramel-app/.env.example apps/caramel-app/.env` (secrets table in README) → `pnpm dev:compose` (pg :58005, redis :58006) → `pnpm --filter caramel-app db:migrate:deploy`.
- Run: `pnpm dev` (app :58000 + extension web-ext) · app only: `pnpm --filter caramel-app dev`.
- Test: `pnpm test` (turbo → vitest: app `tests/unit/**/*.test.{ts,tsx}` + extension `tests/*.mjs`) · single file: `pnpm --filter caramel-app exec vitest run tests/unit/<file>` · e2e: `pnpm --filter caramel-app test:e2e` (needs DB+migrations) · evals (live LLM, costs money): `pnpm --filter caramel-app eval` (needs `OPENROUTER_API_KEY`).
- Gates (all also run in husky pre-commit + CI): `pnpm lint` · `pnpm lint:oxlint` · `pnpm prettier-check` · `pnpm --filter caramel-app knip` · `pnpm -r run type-check`. Ops: `pnpm --filter caramel-app smoke`, `... check:coupons-schema` (see RUNBOOK.md).

## Architecture (10 lines)

- pnpm@9 monorepo, two packages. `apps/caramel-app` = Next.js 16 App Router: Prisma → auth/user Postgres; the coupon catalog lives in a SECOND, externally-owned Postgres (`caramel_coupons`, written only by an out-of-repo Python service, +3 sanctioned mutations from this app — see DESIGN.md §2 "Write-ownership") read via porsager `postgres` — connection/fragments/zod schemas in `src/lib/couponsDb.ts`, all 13 query fns + the structural drift-gate registry in `src/lib/couponsRepo.ts` (routes never write inline SQL) — every read zod-parsed by `parseCouponRows` (schema drift throws loudly).
- All env access via `src/lib/env.ts` / `env.client.ts` (zod, boot fail-fast via instrumentation.ts). Every API route declares itself through `src/lib/api/withRoute.ts` (CORS/rate-limit/origin/bearer/zod-body/OPTIONS) and errors through `handleRouteError` → Sentry. Coupon domain vocabulary/predicates live ONLY in `src/lib/coupons.ts` (+ SQL fragment factories in couponsDb.ts).
- Extension OAuth session mint: `src/lib/auth/extensionOAuthSession.ts` (one module, deliberately not better-auth — see DESIGN.md).
- `apps/caramel-extension` = plain-JS MV3, NO bundler: content scripts share one global scope, load order = manifest order (`coupon-constants.generated.js` → `caramel-base` → `dom-utils` → `store-detect` → `coupon-apply` → `coupon-fetch` → `coupon-runner`); `background.js` is a separate service-worker realm. LLM surface: `cartClassifier.ts` → `/api/classify-cart` (OpenRouter), eval-gated.
- Deploys: Dokploy/Nixpacks → grabcaramel.com. Local coupons DB does NOT exist — coupon routes 500 `{error}` and health reports `coupons_db: error`; that degraded mode is EXPECTED locally.

## Conventions in force → their enforcing check

- Exact-pinned deps, one root lockfile → `tests/unit/deps-pinned.test.ts` + CI `audit` job (`--audit-level=high`). No `any` → eslint `@typescript-eslint/no-explicit-any` (error). Raw coupon-status literals banned outside `coupons.ts`/generated file → `tests/unit/no-raw-coupon-status.test.ts`. Generated extension constants byte-synced → `tests/unit/coupon-constants.generated.test.ts` (regenerate via `pnpm --filter caramel-app generate:coupon-constants`, NEVER hand-edit; codegen must emit prettier's fixed point — format via prettier API). Root-file allowlist + manifest integrity → `tests/unit/repo-integrity.test.ts`. Extension payload budgets → size-limit (92 KB summed content-scripts group; ~0.9 KB headroom). Eval gate ≥0.85 primary-match, PR path-filtered + nightly → `ai-evals.yml`; model/prompt changes need `pnpm eval` green ×2 + a dated `evals/SCOREBOARD.md` row. knip green with zero unjustified ignores. Coupons SQL lives only in `src/lib/couponsRepo.ts` (never inline in a route/page) → the structural drift gate (`pnpm --filter caramel-app check:coupons-schema`, `tests/drift/coupons-schema.drift.ts`) runs every registered query for real against a live coupons DB, replacing the old hand-maintained `EXPECTED_COLUMNS` mirror (deleted — it missed JOIN/WHERE columns absent from every zod output). No coupons/sources/verification\_\* schema in `prisma/schema.prisma`, ever (secrecy forward-rule, DESIGN.md §2(k)) → no automated check yet, `TODO:` a CI grep gate. Unenforced (memory only): new routes must use `withRoute`; env reads only via the env modules; new `.eval.ts` stays out of the unit glob.

## Gotchas (each cost a real debugging round)

- `vi.mock('@/lib/couponsDb', {...importActual})` does NOT intercept internal calls of re-exported functions (closure binds the real module) — read the header comment in `tests/unit/coupons-visibility.test.ts` before touching such mocks.
- No `.gitattributes`: a fresh Windows clone with `core.autocrlf=true` breaks the byte-exact generated-file test — `git config core.autocrlf false` + re-checkout (LOCAL-DEV.md troubleshooting).
- `openai/gpt-5-mini` is a REASONING model: completion budget must include hidden reasoning tokens (`maxTokens: 600`, see F-017 in `evals/SCOREBOARD.md`) — never trim it back to "just enough JSON".
- Extension cross-file globals: a function used only from a sibling content-script file needs `// oxlint-disable-next-line no-unused-vars` as the LAST comment line above it (prettier reorders otherwise); `_isDevInstall` must stay in `caramel-base.js` (called at module-eval time — cross-file hoisting doesn't exist).
- `server-only` throws under vitest — shimmed once in `tests/setup.ts`. `.env*` is gitignored — a new shareable env-named file needs a `!` negation entry (`.env.example` burned us).
- The one standing red: e2e `extension-smoke` manifest-matches vs supported-sites drift (pre-existing, NF-03).

## Hard boundaries (never without explicit human direction)

- Never push to or merge into `dev`/`main`; audit PRs are merged by humans only. Never mutate GitHub repo settings.
- The coupons DB is read-only by discipline — no new write paths (`increment`/`expire`/`sources POST` are the sanctioned exceptions); its schema is owned by the external Python service.
- Don't convert the extension to a bundler/ESM, don't "fix" `local-dev/docker-compose.yml` to run the apps (F-016 one-root-compose is a separate gated initiative), don't re-flag the deliberate designs listed in DESIGN.md §standoffs.
