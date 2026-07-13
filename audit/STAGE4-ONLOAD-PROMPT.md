# STAGE 4 ONLOAD — caramel audit (for the returning Fable/CTO session)

**Doctrine:** canonical rules = `~/.claude/skills/codebase-audit/references/shared-claude-rules.md` — **v5, 2026-07-10** at Stage-3 close. Re-read at onload; if newer than v5, re-sync `audit/rules-checklist.md` first. Grade against the FILE.

Stages 2–3 are COMPLETE (Opus lead session, 2026-07-11). Your job: **end-review (rule pass/redo per fix) + author the Stage-4 `CLAUDE.md`** (DESIGN.md/RUNBOOK: RUNBOOK.md already exists via F-011 — verify rather than re-draft; DESIGN.md = Sonnet-drafted, you verify).

## Read in order (all on disk; nothing lives only in conversation)

1. `audit/stage3-results.md` — ★ FINAL SUMMARY header + per-fix logs (plan-vs-actual, deviations, checks, amendments, empirical deltas). The single best review surface.
2. `audit/findings-post-fix.json` — per-finding commits/status/premise-corrections + NF-01…NF-12 (next cycle) + next-audit focus.
3. PR #111 (https://github.com/DevinoSolutions/caramel/pull/111) — final body = review map + reviewer caveats + human handoffs. **Never merge it — the human does.**
4. `audit/e2e-validation.md` — 7/7 PASS details. `audit/empirical-*-after.md` ×4 — measured deltas (note the lead-verification footnotes correcting Haiku mis-scores; spot-check them if skeptical).
5. `audit/state.json` — full decision log (JC-1…5, CR-1…9, stage2 approval rulings, stage3 close-out).
6. Diffs: branch `audit/fixes-2026-07-10` @ `145fb10`, 19 commits, one per finding — `git log --oneline 9cac6fd..145fb10` and per-commit review.

## Key rulings to re-examine at end-review (the deliberate judgment calls)

- **F-017 fixed in-train** (new finding, micro-plan `PLAN-F-017.md`, self-approved): the "mid-fix discoveries = next cycle" doctrine was deliberately overridden for gate-integrity (red-at-birth eval gate + ~dead shipped feature). Verify the eval evidence chain (SCOREBOARD red row → green row).
- **F-006 filters behavior change** (the train's ONE deliberate user-visible change) — staging-verifiable only; 1-line rollback documented.
- **F-007 STOP-DESIGN**: oauth mint centralized (NOT routed through better-auth — no public API in 1.5.3; parked as NF-07). Wire-identity was pin-proven.
- **JC-2**: branch protection NOT flipped by agents — commands in RUNBOOK/PR for the human.
- **Five amendments** (4 lead, 1 resumed-executor) — all train-introduced defects fixed under the originating F-ID; check none masked a deeper issue.
- **Sub-1.0-confidence Haiku empirical rows were corrected by the lead with line evidence** (3am AM-11; onboarding OB-3/5/11/14) — the corrections are inline in the after-files with footnotes.

## Stage-4 deliverables (yours)

- **`CLAUDE.md`** (≤150 lines): embed the shared block FROM the canonical rules file (never retyped, keep its version header) + project commands (`pnpm dev/test/eval/smoke/check:coupons-schema`, migration cmd), ~10-line architecture, conventions ACTUALLY in force (tests in `tests/unit/**`; one env module; withRoute for every route; handleRouteError; coupon domain module + generated extension constants — regenerate never hand-edit; no-explicit-any; pinned deps + guard test; oxlint disable-comment placement; codegen emits prettier fixed-point), gotchas from stage3-results (vi.mock importActual closure trap; CRLF/.gitattributes; eval files outside unit glob; size-limit group budget), hard boundaries (never merge audit PRs; F-016 own initiative; extension = plain scripts no bundler; coupons DB read-only discipline).
- **Enforcement map** (rules-become-checks): rule → its enforcing check (most already exist: deps-pinned test, raw-status ban gate, repo-integrity gate, sync test, no-explicit-any, audit gate, size-limit, husky chain) or "unenforced — memory only".
- **`DESIGN.md`**: module boundaries + THE STANDOFFS (F-002 body-parse swallows downstream-validated = intentional; stats verifiedCensusSql deliberate; oauth mint centralized-not-better-auth; health-route Bearer kept) so future agents don't re-flag deliberate design. Known debt = NF-01…NF-12 + 13 majors + F-016.
- Relocate the eval codify block from `evals/README.md` into CLAUDE.md (F-012 note).
- **Validation:** fresh zero-context Haiku re-runs the onboarding trace WITH CLAUDE.md present + the name-only navigation test; every stumble = doc defect; fix and re-run until clean.

Then report to the human: pass/redo per fix + the Stage-4 docs + the follow-up ask (mark NF findings agree/disagree/unsure).
