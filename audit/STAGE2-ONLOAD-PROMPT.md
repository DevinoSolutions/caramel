# STAGE 2+3 ONLOAD — caramel audit (for a fresh Opus lead session)

**Doctrine:** canonical rules = `~/.claude/skills/codebase-audit/references/shared-claude-rules.md` — **v5, 2026-07-10**. Grade against the FILE, not this doc or any paraphrase. Re-read it at onload; if newer than v5, re-sync `audit/rules-checklist.md` before planning.

You are the **Opus lead** for Stages 2 (Plan) and 3 (Fix) of the caramel codebase audit. Stage 0–1 (audit + synthesis + triage) is DONE by the Fable/CTO session. **Do not re-audit or re-plan the findings** — they are verified and adversarially reviewed. Execute.

## Read first (on disk, in order)

1. `audit/GOALS.md` — mission, branch policy, model routing.
2. `audit/AUDIT.md` — the report: 16 findings, anchored scores, **the leverage-ordered roadmap (Waves 1–4 + F-016 separate track)**, breaking-change flags.
3. `audit/findings.json` — machine-readable findings F-001…F-016 with verbatim quotes, standoff caveats, corroboration.
4. `audit/triage.md` — the fix/defer/reject recommendations + PR-granularity decision.
5. `audit/rules-checklist.md` — v5 grading (what's enforced vs missing).
6. `audit/state.json` — pipeline state + decision log (append your judgment calls here; never rewrite history).

## Branch & PR rules (user-directed — non-negotiable)

- **Target branch = `audit/dev-2026-07-10`** (already cut from `dev`@537547b and pushed). Treat it as "the dev" for this run. ALL PRs target it. **Never** PR or merge to real `dev` or `main`. **Never merge any PR** — the human reviews and merges.
- Fix work on `audit/fixes-2026-07-10` cut FROM the target. Serial execution in the roadmap's wave order; each fix builds on the previous fix's final commit. **One commit per finding**, subject references the F-ID (e.g. `fix(F-005): zod-validated env module + regenerated .env.example`).
- Group commits into PR(s) by wave for coherent review (or one PR per finding — either is fine; the F-ID-per-commit trace is the requirement). Link the finding ID + AUDIT.md section in each PR body.

## How to run it (Fable presence budget: you own the middle)

- You are the lead: spawn **Opus** subagents for planning (one plan per finding, batch trivially related), **Sonnet** for fix execution and doc drafts, **Haiku** for the after-fix empirical re-runs and quote checks. Rule on minor deviations yourself; log them in `state.json`. Structural deviations → re-plan; scope changes → escalate to the human. E2E validation (Stealth MCP / Chrome DevTools) is done by Opus subagents, not by burning the lead loop in a browser.
- **Stage 2 (Plan):** per finding — scope (exact files + explicit out-of-scope), approach + rejected alternatives, sequencing (independently verifiable steps), breaking changes (who consumes it, told?), **test strategy — pinning/characterization tests written BEFORE the change**, rollback + checkpoint commits, risk. Write each to `audit/plans/PLAN-F-0XX.md`. Cross-review for overlapping files (F-002/F-007 both touch route error paths; F-006/F-007 both touch routes; F-009 deletes fossils F-007 depends on — sequence F-009 before F-007).
- **Stage 3 (Fix):** pinning tests first; full suite green at every checkpoint (note: F-004 CREATES the suite — until it lands, "green" means the new tests you add for the file you touch). No drive-by refactors; mid-fix discoveries become NEW findings for the next cycle, not extra edits. After each fix, a fresh Haiku re-runs the relevant empirical test (change-trace / 3am / onboarding / navigation) — improvement measured, not claimed.

## Hard sequencing (from the roadmap — respect it)

- **Wave 1 first:** F-004 (test infra) → F-005 + F-009. F-004 is the prerequisite for F-006/F-007/F-008.
- **F-009 before F-007** (F-009 deletes the dead withAuth/cors fossils that F-007 replaces).
- **F-008 only after F-004** (characterization tests first — it's the #1-churn file, 1536 lines).
- **F-010 (docs) LAST** before Stage 4, so docs describe the changed reality.
- **F-016 (one-root-compose) is a SEPARATE initiative** via the `/one-root-compose` skill — large, breaking, prod-cutover. Do NOT fold it into the fix-branch train. caramel is NOT in the PROD-GATE exception list, but still: no prod moves without explicit human go.

## Critical caveats to honor (from adversarial review)

- **F-002:** `onRequestError` IS wired (`instrumentation.ts:12`) — the gap is the `try/catch → return 500` paths, not "no Sentry ever." The `.catch(()=>({}))` body-parse swallows are mostly downstream-validated; the real Critical is empty-success shaping + decrypt-return-raw. Don't "fix" what isn't broken.
- **F-009:** `apiResponseNext.ts` is LIVE (used in `sources/route.ts`) — do NOT delete it. The fossil set is the ~5 knip-whitelisted NextApi\* files (cors.ts, initMiddleware.ts, middlewares/\*\*, securityHelpers/apiResponse.ts).
- **F-003:** rotating `EXTENSION_API_KEY` breaks in-the-wild extension installs — coordinate with an extension release; the server must tolerate old clients during the window (store-review lag).
- **Green-suite rule:** there is NO existing suite (F-004). Never claim a fix is safe from a suite that doesn't cover it — write the pinning test first.

## When you finish

Write per-item plan-vs-actual + deviations + commit SHAs, before/after empirical numbers, updated `findings.json`, any new findings, and next-audit focus to `audit/`. Then STOP. The user returns to the Fable/CTO session and asks "is it all good?" — Fable reviews the artifacts + diffs and rules pass/redo, then authors the Stage-4 `CLAUDE.md`.
