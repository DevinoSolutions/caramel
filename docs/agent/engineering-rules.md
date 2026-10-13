# Engineering rules — moved detail (provenance, one-root-compose, AI evals)

Moved verbatim from CLAUDE.md on 2026-10-07 (CLAUDE.md was slimmed to cut context-window cost). Every bullet/paragraph below is unchanged; only the headings and the notes in this style are new.

## Shared-rules header comments (v5 provenance and version history)

<!-- source: Amin+Aladdin eng discussion 2026-07-04→07 (devinorules.txt) + shorty audit cycle 1 + Amin+Aladdin Discord 2026-07-09 (one-compose / dev-runs-prod-build) + shorty AI-evals build 2026-07-09 (Amin: evals "part of the CI/CD pipelines… treat it like maintaining it like playwright"). -->

<!-- consumed by exactly TWO skills, no other copies anywhere: (1) codebase-audit — grades against this file; Stage 4 embeds this block at the top of the project CLAUDE.md (keep this header), project specifics BELOW it; (2) devino-codebases — reads this file fresh at run start and codifies into the project CLAUDE.md the same way. Project CLAUDE.md embeds are version-stamped OUTPUTS, re-synced on the next audit/codify/devino-codebases touch — never edited by hand, never canonical. The /ai-evals skill BUILDS what §"AI quality (evals)" demands; these two skills only grade/verify against it. -->

<!-- v2 changes vs v1 (2026-07-06): added non-ambiguous naming, monorepo shared-UI, suppression/raw-form check examples, quick-wins lens. All other rule content verbatim v1. -->

<!-- v3 changes vs v2 (2026-07-09): added one-root-compose + dev-runs-prod-build rule under Structure (Amin: "pnpm dev just runs docker compose up --build" — identical local/prod behavior for AI agents beats hot reload; applies to Postify, uNotes, GetItDone, Shorty). All other rule content verbatim v2. -->

<!-- v4 changes vs v3 (2026-07-09): added §"AI quality (evals)" (shorty PR #217: eval suites on Mastra runEvals, ai-evals.yml CI wiring, eval-gated model sweep gpt-4o→5.4 / gemini-2.5→3.1; proving red-check demo PR #219). All other rule content verbatim v3. -->

<!-- v5 changes vs v4 (2026-07-10, after the BioFlow prod migration): one-root-compose clarified to the LITERAL reading (prod runs the same compose file as ONE platform compose service, not merely the same Dockerfiles across separate apps); PROD-GATE exception added for uNotes/Shorty/GetItDone (dev environment only until Aladdin manually confirms prod in-session); migration playbook + Dokploy gotchas live in the /one-root-compose skill (which supersedes ~/.claude/prompts/compose-parity.md). All other rule content verbatim v4. -->

## Structure — the full one-root-compose rule

Note: the PROD GATE EXCEPTION sub-bullet that follows this rule stays in CLAUDE.md (hard rule).

- ONE root docker-compose runs the real service graph (web, workers, sidecars, DB) with prod-mode builds — local, CI, and prod are the same graph, and "same" is LITERAL: production runs this exact file as ONE platform compose service (Dokploy compose, github-sourced, autodeploy on push), not merely the same Dockerfiles across separate apps (ratified during the BioFlow migration 2026-07-10). The dev command (`pnpm dev`) is `docker compose up --build`, NOT framework dev mode: hot reload is deliberately traded away so agents see identical behavior locally and in prod (Amin+Aladdin 2026-07-09). A missing/broken root compose is a P1 finding, never silently punch-listed. Migrating a deployed app onto compose = backups first (VERIFY they restore), then dark bring-up (stack deployed with NO domains + autodeploy OFF, data restored, storage mirrored, internally smoked) BEFORE any traffic moves — the full proven playbook + platform gotchas (unique network aliases / isolatedDeployment, stale traefik file-provider routers, env-writer quirks, autodeploy webhook races, platform-native backups) is the **/one-root-compose skill** (~/.claude/skills/one-root-compose/SKILL.md — supersedes ~/.claude/prompts/compose-parity.md): follow it, don't rediscover it. Check: gates script asserts root compose exists + service set matches prod + `dev` script shape (`TODO:` where not yet wired).

## AI quality (evals) — full rules

Note: the short bullet "Real production AI failures become eval cases before (or with) the fix." stays in CLAUDE.md.

- Every user-facing LLM surface (chat, agent, summarizer, generation) has an eval suite: fixed dataset → the LIVE production model + prompts → programmatic scorers → pass-rate threshold gate. Suites import the production prompts/schemas/tools — a copied prompt drifts silently and is a finding. Deterministic check-scorers first; LLM-as-judge only where a rule genuinely can't be crisp. Eval files stay out of the unit-test glob (live calls cost money — `.eval.ts` suffix / not `test_*.py`).

- Evals run in CI as a standing, permanently maintained gate: PR-triggered on AI-touching paths (path-filtered so unrelated PRs never pay or see a stochastic red), nightly against live models with an auto-opened issue on failure (the only thing that catches a provider changing a model with zero code change), plus manual dispatch for model work. Evals that exist but only run locally are a finding.

- Model changes are eval-gated: suite green TWICE + a dated scoreboard row (result, price, latency) before the swap ships; keep one regression proof on record (the rejected/old model measurably failing the suite — the evidence the gate works). At every swap, audit deploy-time model pins (host env like `CHAT_MODEL`) against code defaults — a stale pin silently overrides the code.

- CI secrets are verified to EXIST (`gh secret list`) — workflow `secrets.*` references resolve to empty strings when unset, silently, and nothing fails until something actually consumes them. Check: ai-evals workflow present + its path filter matches the repo's actual AI surfaces (`TODO:` where not yet wired).
