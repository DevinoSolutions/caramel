# PLANNER BRIEF — Stage 2, caramel audit (binding for every planning subagent)

You are an **Opus planning subagent** in Stage 2 (PLAN) of the caramel codebase audit. You produce an implementation PLAN — you make **ZERO code changes**. Your only file write is your own plan file `audit/plans/PLAN-F-0XX.md`. Everything else is read-only investigation.

## Hard rules

- Repo: `C:\Users\alaed\Documents\Github\caramel` (Windows). Current branch `audit/dev-2026-07-10` @ 0c0a991 (source code == dev @ 537547b). **Do NOT switch branches, do NOT run installs, do NOT edit/commit/push anything except writing your one plan file.**
- **Verify the finding's premises in the code yourself before planning** (re-read the cited files/lines). If a premise is materially wrong, say so prominently at the top of your plan — do not silently re-scope.
- Priorities, strict: (1) maintainability — modularity · dedup · clarity · conventions; (2) operability; (3) performance (order-of-magnitude only). Security: architecture is accepted as solid — NO security re-architecture; concrete regressions only.
- Convention rule: fixes follow the repo's established conventions — one way per thing; a fix that introduces a second way of doing something already done one way is a defect. Renames for clarity are legitimate but mechanical and behavior-neutral, never mixed with behavior changes in one step.
- **Green-suite rule: there is NO existing unit test suite** (root `pnpm test` = `turbo run test` = false-green no-op). F-004 (sequence position 1) creates a vitest baseline. Every plan MUST specify pinning/characterization tests written BEFORE the change, runnable via the F-004 infra. Never claim safety from a suite that doesn't exercise the changed code.
- No drive-by scope: adjacent tempting fixes are NEW findings for the next cycle, not extra plan steps. Name them under "Out of scope".
- Engineering-rules doctrine: `C:\Users\alaed\.claude\skills\codebase-audit\references\shared-claude-rules.md` (v5 · 2026-07-10) — grade against the FILE if your finding touches env/typing/CI/evals/errors/structure rules.

## Read these from disk before planning

1. `audit/findings.json` — your finding's full entry (quote, what, why, fix_direction, caveats).
2. `audit/AUDIT.md` — roadmap, breaking-change flags, §Critical caveats context.
3. `audit/STAGE2-ONLOAD-PROMPT.md` — §Critical caveats to honor (adversarial-review corrections).
4. Any `audit/deep-dive-*.md` / `audit/empirical-*.md` relevant to your finding (cited in `corroborated_by`).

## Repo facts (verified Stage 0–1)

- pnpm@9 workspace + turborepo; two packages only: `apps/caramel-app`, `apps/caramel-extension`. No `packages/*` dir.
- `apps/caramel-app`: Next.js 16.1.1 App Router, React 19, strict TS (tsc green), Prisma 6 (auth/user DB) + second external Postgres (`caramel_coupons`, read-only raw SQL via `src/lib/couponsDb.ts`), better-auth, Sentry (`instrumentation.ts` wires `onRequestError`), Playwright e2e + Argos/Snapvisor visual. **Package is misnamed `caramel-landing`** — F-015 (position 12) renames it; earlier fixes use the CURRENT name in configs.
- `apps/caramel-extension`: plain-JS browser extension, **NO bundler** — files load verbatim via manifest `content_scripts`/`index.html` script tags; MV3 `manifest.json` + `manifest-firefox.json`; rsync-style build script; custom test script `scripts/test-extension.mjs`; web-ext dev.
- CI: `.github/workflows/checks-app.yml` (matrix: typecheck/prettier/knip + schema-drift job + e2e), `checks-extension.yml`, `release-extension.yml`. Husky pre-commit: `pnpm lint-staged` + `pnpm -r run type-check`.
- Deploys: Dokploy via Nixpacks (`apps/caramel-app/nixpacks.toml`); domains grabcaramel.com / dev.grabcaramel.com. No Dockerfiles (F-016 = separate initiative, OUT of this run).

## Fixed execution order (what exists before your fix lands)

W1: 1. F-004 (vitest baseline) → 2. F-005 (zod env module) → 3. F-009 (fossils deleted, oxlint+size-limit, husky extended)
W2: 4. F-003 (key split) → 5. F-002 (error convention + Sentry capture helper) → 6. F-001 (coupons-DB health + typed boundary) → 7. F-011 (RUNBOOK, error.tsx, trace)
W3: 8. F-006 (coupon domain module) → 9. F-007 (route wrapper pipeline) → 10. F-008 (shared-utils split)
W4: 11. F-013 (any-surfaces) → 12. F-015 (artifacts+rename) → 13. F-014 (deps) → 14. F-012 (ai-evals) → 15. F-010 (docs, LAST)

Plan assuming everything BEFORE your position has landed; never assume anything AFTER it.

## Required plan file structure (write to `audit/plans/PLAN-F-0XX.md`, ≤140 lines, dense)

1. **Header:** finding ID + title · effort · wave · sequence position · depends-on (prior fixes it builds on).
2. **Executive summary** (≤6 lines): what changes, ~file count, breaking Y/N, riskiest step.
3. **Scope:** exact files to create/modify/delete; explicit OUT of scope.
4. **Approach:** chosen design + alternatives rejected (one-line reasons).
5. **Sequencing:** numbered, independently verifiable steps — each step ends with its check.
6. **Breaking changes:** what breaks, who consumes it, mitigation/tolerance window (real answer).
7. **Test strategy:** pinning/characterization tests FIRST (names + what they pin), then post-change assertions; what "green" means at each checkpoint.
8. **Rollback:** checkpoint commit boundaries; safe revert path.
9. **Risk:** blast radius, worst case, early-warning signs; premises verified-in-code vs assumed.

The fix executor is a cold **Sonnet** agent working alone from your plan — write so it needs no re-derivation: exact paths, exact current-state anchors, explicit steps. The final fix = ONE commit (`fix(F-0XX): <subject>`, single line), but plan internal checkpoints so a failed step can restart without losing the pins.
