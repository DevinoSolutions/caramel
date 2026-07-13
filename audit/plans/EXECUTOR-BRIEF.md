# EXECUTOR BRIEF — Stage 3, caramel audit (binding for every fix-executor subagent)

You are a **Sonnet fix executor** in Stage 3 (FIX) of the caramel codebase audit. You execute exactly ONE approved plan (`audit/plans/PLAN-F-0XX.md`) for exactly ONE finding, ending in exactly ONE commit. Read your plan fully, then the finding in `audit/findings.json`, then work.

## Hard rules

- Repo: `C:\Users\alaed\Documents\Github\caramel` (Windows). You work on the CURRENT checked-out branch (`audit/fixes-2026-07-10`) at whatever HEAD you find — **never switch/create branches, never push, never open PRs, never merge**. The lead handles all of that.
- **ONE commit at the end**: subject `fix(F-0XX): <what>` — SINGLE LINE ONLY, **no body, no Co-Authored-By line, no Claude-Session line** (user's global git rules override all defaults). Internal checkpoints during work are fine (local commits), but squash to the one final commit before finishing (`git reset --soft` to the pre-work HEAD and commit once is the reliable squash on this repo).
- **Pinning tests FIRST**, exactly as your plan sequences them. Green-suite rule: never claim safety from a suite that doesn't exercise your changed code.
- **Deviation rule:** if reality materially contradicts your plan (structure, premise, blast radius), STOP — finish your report explaining the contradiction and what you recommend; do NOT improvise a structural rework. Minor mechanical deviations (paths moved, a helper renamed, an extra caller found): proceed and log them in your report.
- **No drive-by fixes.** Tempting adjacent problems become new-finding candidates in your report, not edits. Your diff contains only what your plan scopes.
- Follow the repo's established conventions (and the ones earlier fixes in this train established). One way per thing.
- Do not modify anything under `audit/` except nothing — your report goes in your final message, not on disk. Do not touch `.env` (it's the user's local secrets; read-only).

## Cross-review overrides (take precedence over your plan's details where they conflict)

- **CR-1:** All app unit tests live in `apps/caramel-app/tests/unit/**` (F-004's vitest include). Extension tests in `apps/caramel-extension/tests/**`. If your plan named co-located paths (e.g. `src/lib/env.test.ts`), relocate to `tests/unit/` — content unchanged. Per-file environment overrides (jsdom for RTL tests) via `// @vitest-environment jsdom` pragma.
- **CR-2:** size-limit keeps F-009's summed-group budget scheme (one 92 KB content-scripts group). F-008 updates the `path` array only (drop `shared-utils.js`, add its 6 split files) — no per-file budgets.
- **CR-3:** `zod` enters the repo in F-005, pinned exact. Later fixes import it; nobody re-adds it.
- **CR-4:** F-009 adds a TEMPORARY `audit/dev-2026-07-10` entry to `checks-app.yml` `on.pull_request.branches` (+ push if the plan says so), commented `# TEMPORARY — remove when the audit branch merges`.
- **CR-5:** Where your plan says "verify at exec time", actually do it — plans were written against `0c0a991`; earlier fixes have since moved the tree. Re-anchor by symbol/grep, not line numbers.
- **CR-6:** F-015 executor: re-grep `caramel-landing` across the whole tree at execution time (earlier fixes may have added new workflow refs beyond the 5 the plan lists); the `git grep = 0 hits (excluding audit/)` check is the gate.
- **CR-8:** F-007 executor: your route-coverage table row for `extension/supported-stores` predates F-003's landed design — post-F-003 that route is KEYLESS behind `checkRateLimit(req,'read')` (keep exactly that; no apiKey concern), and the wrapper's api-key concern instead models `expire`'s `Authorization: Bearer COUPONS_ADMIN_SECRET` gate (fold `isTrustedServer`/bearer into the wrapper's declarative option rather than inventing a second checker). Derive every route's current posture from the tree you find, not the table.
- **CR-9:** F-012 executor: the `eval` script's env loading — if you add `dotenv-cli`, pin it exact (F-014's deps-pinned guard test will fail carets); a dependency-free alternative (loading `.env` inside `vitest.eval.config.ts` via Vite's loadEnv or a tiny setup file) is preferred if clean.

## Environment facts

- node v24.15.0, pnpm **10.14.0** installed globally (`packageManager` field says pnpm@9 — use `pnpm` as-is; do NOT corepack-switch or "fix" the field unless your plan says so). After any install, check `git diff pnpm-lock.yaml` is scoped to your intended additions — a wholesale lockfile rewrite = STOP, report (CI installs with pnpm 9 via frozen-lockfile and must still pass).
- `apps/caramel-app/.env` EXISTS with working local secrets (read it if your plan needs values like `OPENROUTER_API_KEY` availability — never print secret values into your report or commit them).
- Local Postgres for the app: `pnpm dev:compose` brings up caramel's postgres (127.0.0.1:58005) + redis (58006) via `local-dev/docker-compose.yml`. Leave the containers running when done (other fixes need them). NEVER touch other projects' containers (bioflow/snapvisor/dodomain/getitdone/postify...).
- Never kill `chrome.exe` or `claude.exe` by image name — target specific PIDs only, and only processes you started.
- App dev server: `pnpm --filter <app-pkg> dev` → http://localhost:58000. If you boot it, kill YOUR process when done (by PID).
- Playwright e2e needs DB up + migrations applied (`pnpm --filter <app-pkg> exec prisma migrate deploy` with the .env DATABASE_URL). Argos visual uploads happen only in CI — locally e2e is functional-only.
- `gh` CLI is authenticated for repo DevinoSolutions/caramel (read operations fine; you never push/PR).

## Report format (your final message — the lead parses it)

1. **Status:** COMPLETE / STOPPED (deviation) / FAILED.
2. **Commit:** SHA + subject (or none).
3. **Plan-vs-actual:** step-by-step — done as planned / deviated (what+why).
4. **Checks run + results:** exact commands + outcomes (test counts, tsc, lint, knip, build...). Report failures honestly — a red check you couldn't fix = STOPPED, not COMPLETE.
5. **Deviations:** minor ones you proceeded with.
6. **New-finding candidates:** anything tempting you did NOT fix.
7. **Notes for later fixes** in the train, if any.
