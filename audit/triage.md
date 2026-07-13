# Triage — caramel audit (self-triage under pre-authorized gate collapse)

Gate mode: the user directed "make a branch out of dev and consider it the dev … do PR to that branch." Per the runner's gate-collapse rule, ⛔ triage + plan-approval collapse into PR review. I (Fable, orchestrator) self-triage below with rationale; the PRs into `audit/dev-2026-07-10` are the human review surface. **Recommendations lead — the human can override any row before/after the Stage-2/3 session runs.** No agent merges.

Triage lens: value-vs-effort against caramel's vision, maintainability (P1) + operability (P2) first.

| ID        | Sev  | Eff | Recommendation                                       | Rationale                                                                                               |
| --------- | ---- | --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **F-004** | High | L   | **FIX (Wave 1, first)**                              | Unlocking: no other refactor is safe without it. Highest leverage in the audit.                         |
| **F-005** | High | M   | **FIX (Wave 1)**                                     | Cheap; fixes broken first-run and fails-fast on bad env; enforces later rules.                          |
| **F-009** | High | M   | **FIX (Wave 1)**                                     | Cheap guardrails; deletes the dead wrappers F-007 replaces; makes CI actually gate.                     |
| **F-001** | Crit | M   | **FIX (Wave 2)**                                     | The predicted outage. Health-check the coupons DB + typed boundary. High operability value.             |
| **F-002** | Crit | M   | **FIX (Wave 2)**                                     | The honesty-violation + telemetry-blindness spine. Pair with F-001.                                     |
| **F-003** | Crit | S   | **FIX (Wave 2, early)**                              | Small, concrete security regression. ⚠ rotates a shipped key — coordinate extension release.           |
| **F-011** | High | M   | **FIX (Wave 2 → Stage 4)**                           | RUNBOOK + error boundary; documents what F-001/F-002 create.                                            |
| **F-006** | High | M   | **FIX (Wave 3)**                                     | Prime P1 dedup; already drifting. Benefits from F-004 tests.                                            |
| **F-007** | High | M   | **FIX (Wave 3)**                                     | P1 modularity; depends on F-009 (fossils gone), pairs with F-002.                                       |
| **F-008** | High | L   | **FIX (Wave 3, gated)**                              | Highest change-risk file. **Characterization tests (F-004) FIRST.** ⚠ ext refactor + store-review lag. |
| **F-012** | High | M   | **FIX via /ai-evals**                                | Independent track; the skill is the install path. Cheap given the skill.                                |
| **F-013** | Med  | M   | **FIX (Wave 4)**                                     | Mechanical; type exported surfaces first (kills contagion).                                             |
| **F-014** | Med  | M   | **FIX (Wave 4)**                                     | Patch crit/high vulns + replace deprecated dep + pin + single lockfile.                                 |
| **F-015** | Med  | S   | **FIX (Wave 4)**                                     | Mechanical; the amazon.js broken ref is a real Firefox-build bug.                                       |
| **F-010** | High | M   | **FIX (Wave 4, LAST)** → Stage 4                     | Do after structural changes so docs describe reality; validated by onboarding trace.                    |
| **F-016** | High | L   | **FIX as SEPARATE INITIATIVE via /one-root-compose** | Large, breaking, prod-cutover. Do NOT fold into the above PRs. Rule forbids dropping it; own track.     |

**No REJECTs. No DEFERs recommended** — every finding is net-positive at its effort. The only sequencing caveats: F-008 must not start before F-004 lands; F-016 is a self-contained migration (its own skill), not part of the fix-branch train.

**PR granularity (per user's "do PR to that branch"):** one branch `audit/fixes-2026-07-10` off `audit/dev-2026-07-10`, **one commit per finding** (subject references the F-ID), opened as PR(s) into the target. Waves may be grouped into a small number of PRs by wave to keep review coherent, or one PR per finding if the executor prefers — either is acceptable; the finding-ID-per-commit trace is the requirement. Deviation from upstream "one PR per fix" is intentional and recorded here.
