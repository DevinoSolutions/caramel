# Audit GOALS — caramel

**Doctrine:** canonical rules = `~/.claude/skills/codebase-audit/references/shared-claude-rules.md` — **v5, 2026-07-10**. Grade against the FILE, not this doc or any paraphrase. At every stage onload, re-read it; if its version is newer than v5, re-sync `audit/rules-checklist.md` before proceeding.

## Mission

Full codebase-audit pipeline (AUDIT → PLAN → FIX → CODIFY) on the caramel monorepo. Priorities, strict: (1) maintainability (modularity · dedup · clarity · conventions), (2) operability, (3) performance (order-of-magnitude only). Security arch accepted as solid — concrete quote-backed regressions only.

## Branch policy (user-directed, 2026-07-10)

- Baseline: `dev` @ `537547b3081aa3a0ec817cdc5f6dac4f0d328dbb`.
- **Target branch: `audit/dev-2026-07-10`** (cut from dev @ 537547b, pushed to origin). Treat it as "the dev" for this run — ALL fix PRs target it, never the real `dev` or `main`.
- Fix work happens on `audit/fixes-2026-07-10` (branched from the target), one PR per fix (or batched per Fable's cross-review) into `audit/dev-2026-07-10`.
- Never merge anything to `dev` or `main`. Never merge PRs at all — the human reviews and merges.

## Gate mode (recorded decision)

User args: "make a branch out of dev and consider it the dev and then work do pr to that branch basically just follow the audit but consider the new dev branch ur target" — read as pre-authorization to run the pipeline through to PRs against the isolated target branch. Therefore: ⛔ triage and ⛔ plan-approval gates collapse into PR review. Every self-triage and self-approval decision gets recorded with rationale in `audit/state.json`. The Stage-1 report still presents the full triage table + recommendations to the human; the human launching the Stage-2/3 Opus session is the go signal.

## Model routing

Fable (CTO) = Stage 0–1 orchestration, synthesis, triage recommendations, handoff docs, final end-review + Stage-4 CLAUDE.md authorship. Fable never edits repo code. Opus lead session = Stages 2–3 (planning, fixes, deviation rulings, E2E validation via Stealth/Chrome DevTools). Sonnet = deep dives, fix execution, doc drafts. Haiku = scans, quote checks, navigation tests.

## Repo facts (Stage 0)

- pnpm@9 workspace + turborepo; apps: `apps/caramel-app` (Next.js 16.1.1, React 19, Prisma 6, better-auth, Playwright+Argos E2E; package misnamed `caramel-landing`) and `apps/caramel-extension` (plain-JS MV extension, rsync build, web-ext dev).
- **No unit-test suite**: `turbo run test` matches zero package scripts. App has `test:e2e` (Playwright), extension has `test:e2e` (custom node script). Forced roadmap consideration: establish a real test baseline.
- Husky pre-commit: `pnpm lint-staged` + `pnpm -r run type-check`.
- CI: `.github/workflows/` (5 files) — inventory in Stage 0 tooling report.
- Two pnpm lockfiles (root + `apps/caramel-app/pnpm-lock.yaml`) — scanner lens.

## Artifacts

- `audit/state.json` — pipeline state, decisions log (append, never rewrite history).
- `audit/exclusions.md` — scanner exclusion list.
- `audit/rules-checklist.md` — one row per v5 rule bullet + CI-stack piece (pass / violation→F-ID / n-a).
- `audit/hotspots-{a,b}.json` — dual Haiku scans. `audit/deep-dive-*.md` — Sonnet dives.
- `audit/empirical-*.md` — change-trace, 3am, onboarding, name-only-navigation.
- `audit/premortem.md`, `audit/findings.json`, `audit/AUDIT.md` (report), `audit/triage.md`.
- `audit/plans/PLAN-F-*.md` — Stage 2. `audit/STAGE<N>-ONLOAD-PROMPT.md` — session handoffs.
