# PLAN-F-009 — CI guardrail stack: delete Pages-Router fossils, truthful knip, add oxlint + size-limit, extend husky

**Finding:** F-009 (High, conf 0.90) · **Effort:** M · **Wave 1 · sequence 3** (after F-004 vitest, F-005 env) · **Depends-on:** F-004 (vitest infra for the guard test). **Must land BEFORE F-007** (F-007 replaces the withAuth/cors fossils this deletes) and BEFORE F-008 (size-limit budget cross-ref).

## Executive summary

Delete 6 dead Pages-Router files (cors, initMiddleware, 3× middlewares, securityHelpers/apiResponse), drop 4 orphan deps (cors,@types/cors,jsonwebtoken,@types/jsonwebtoken), un-hide them from knip so the gate tells the truth, add root **oxlint** (both apps, CI+lint-staged) and extension **size-limit** (content-script + popup budgets), extend **.husky/pre-commit** with knip + prisma validate, and hand the human exact `gh api` branch-protection commands. ~14 files touched. **Breaking: NO** (all deleted code has zero live callers, verified 3 ways). Riskiest step: a dynamic/string import grep can't see — mitigated by a `next build` + e2e checkpoint gate.

## Scope

**DELETE** (all `apps/caramel-app/`): `src/lib/cors.ts` · `src/lib/initMiddleware.ts` · `src/lib/middlewares/{withAuth,withRoles,errorMiddleware}.ts` (whole dir) · `src/lib/securityHelpers/apiResponse.ts`.
**MODIFY:** `apps/caramel-app/package.json` (drop 4 deps) · `apps/caramel-app/knip.json` (prune fossil ignores) · root `package.json` (oxlint devDep + `lint:oxlint` script + lint-staged) · `apps/caramel-extension/package.json` (size-limit devDeps + `size` script) · `.husky/pre-commit` · `.github/workflows/checks-app.yml` (oxlint job + audit-branch trigger) · `.github/workflows/checks-extension.yml` (size-limit step) · `pnpm-lock.yaml`.
**CREATE:** root `.oxlintrc.json` · `apps/caramel-extension/.size-limit.json` · `apps/caramel-app/…/fossil-removal.guard.test.ts` (F-004 layout) · branch-protection commands into PR body + `audit/RUNBOOK` handoff.
**KEEP (do NOT delete — verified live):** `src/lib/apiResponseNext.ts` (used by `app/api/sources/route.ts:1`), `src/lib/securityHelpers/cryptoHelpers.ts` + `decryptJsonData.ts`, `src/lib/gtag.ts` (namespace-imported in `providers.tsx:3`).
**OUT of scope (observations → next cycle):** likely-unused `src/components/StoreButtons.tsx` & `src/lib/capitalizeFirst.ts` (1 self-ref each); possibly-unused UI deps still whitelisted (react-awesome-button/react-fast-marquee/react-lottie-player); duplicate `postcss.config.{mjs,ts}` both ignored; app-bundle size budgets; adding oxlint rules beyond baseline.

## Approach

- **Fossils:** hard-delete + prune the exact knip `ignore` entries that masked them, so knip re-derives truth. _Rejected:_ leaving files and only tightening rules — keeps the lie and the "cold agent copies dead withAuth" trap alive.
- **Deps:** remove `cors`/`@types/cors` (only importer was the deleted `cors.ts`) and `jsonwebtoken`/`@types/jsonwebtoken` (zero source imports anywhere — orphan). Their `ignoreDependencies` entries MUST go too, else knip stays green-but-lying (unjustified ignore). _Rejected:_ keeping jsonwebtoken — no consumer, and a retained ignore is exactly the blind-gate defect.
- **oxlint:** root-level, both apps, **alongside** eslint (v5: "oxlint + the few eslint rules it doesn't cover"). `.oxlintrc.json` correctness=error (fails), suspicious=warn (visible). _Rejected:_ replacing eslint (loses next/react rules oxlint lacks); blanket rule-disable to force green (dishonest).
- **size-limit:** `@size-limit/file` raw-file preset (extension has **no bundler** — files ship verbatim). Budget the **summed content_scripts payload per manifest**, not per-file, so F-008's shared-utils split (redistributes bytes within the same manifest entry) can't break it. _Rejected:_ per-file budgets (F-008 split would trip them arbitrarily); gzip metric (nothing is compressed at inject time — raw == shipped).
- **husky:** add knip + `prisma validate` (schema syntax/relations, no DB) + oxlint (via lint-staged). _Rejected:_ `migrate diff` in pre-commit — needs a live shadow DB (already the CI `schema-drift` job); too heavy locally.
- **Branch protection:** LEAD RULING — no agent settings mutation. Deliver `gh api` commands as human handoff.

## Sequencing (each step ends with its check)

1. **Baselines + guard test.** Record current green: `pnpm --filter caramel-landing knip` (green via whitelist), `type-check`, `build`, `test:e2e`. Add `fossil-removal.guard.test.ts` importing the KEEP-live siblings (`@/lib/apiResponseNext`, `@/lib/securityHelpers/decryptJsonData`, `@/lib/gtag`) + asserting fossil paths absent via `fs.existsSync`. → _guard test passes on current tree (siblings resolve)._
2. **Per-file zero-caller gate, then delete.** For each fossil grep repo (excl. node*modules) for its import path/symbol (`lib/cors`, `initMiddleware`, `withAuth`, `withRoles`, `errorMiddleware`, `onNoMatchMiddleware`, `securityHelpers/apiResponse`); confirm the ONLY hits are the file itself + `knip.json`. Then delete the 6 files. → *`pnpm --filter caramel-landing type-check` green + `next build` green (catches dynamic/string imports).\_
3. **Drop deps + relock.** Remove `cors`,`jsonwebtoken` (deps) and `@types/cors`,`@types/jsonwebtoken` (devDeps) from `apps/caramel-app/package.json`; `pnpm install`. → _install clean, lockfile updated, build still green._
4. **Truthful knip.** From `knip.json` remove `ignore`: cors.ts, initMiddleware.ts, `middlewares/**`, `securityHelpers/apiResponse.ts`; remove `ignoreDependencies`: cors, @types/cors, jsonwebtoken, @types/jsonwebtoken. Leave the rest (each justified below). → _`pnpm --filter caramel-landing knip` GREEN with no fossil entries; if it flags OTHER items, record as observations, do not delete._
5. **oxlint.** Root devDep `oxlint@^1.73.0`; create `.oxlintrc.json` (correctness=error, suspicious=warn, ignore `**/{dist,.next,node_modules}/**` + `apps/caramel-app/public/**`); root script `"lint:oxlint": "oxlint"`. Run it; fix trivial correctness hits, or disable a specific rule with a one-line justification (never blanket). Add `"oxlint"` first in lint-staged `*.{ts,tsx,js,jsx,mjs,cjs}`. Add an `oxlint` job to checks-app.yml (root working-dir, `pnpm install --frozen-lockfile` → `pnpm lint:oxlint`). → _`pnpm lint:oxlint` 0 errors locally + in CI._
6. **size-limit.** In `apps/caramel-extension`: devDeps `size-limit@^12.1.0` + `@size-limit/file@^12.1.0`; script `"size":"size-limit"`; create `.size-limit.json` (see below). Add a `size` step to `checks-extension.yml` `lint_and_build` job. → _`pnpm --filter caramel-extension size` passes at current sizes._
7. **husky.** Append to `.husky/pre-commit`: `pnpm --filter caramel-landing knip` and `pnpm --filter caramel-landing exec prisma validate` (oxlint already via lint-staged). → _stage a trivial edit, run `.husky/pre-commit`; all gates execute and pass._
8. **CI reach (temporary).** Add `audit/dev-2026-07-10` to `checks-app.yml` `on.pull_request.branches`/`push.branches` so the new gates actually run on this cycle's PRs (checks-extension already runs on all PRs). Comment it TEMPORARY — revert when the audit branch merges. → _push shows app checks running on the audit PR._
9. **Branch-protection handoff (no mutation).** Put the commands below in the PR body + `audit/RUNBOOK`. → _human runs them post-merge._
10. **Final green** (knip-truthful, type-check, oxlint, size, build, e2e) → ONE commit `fix(F-009): delete Pages-Router fossils, truthful knip, oxlint + size-limit, husky knip+prisma`.

### `.size-limit.json` (extension; current sums → budget w/ ~10-13% headroom, split-invariant)

`[{"name":"content-scripts (injected)","path":["cart-signals.js","shared-utils.js","UI-helpers.js","inject.js"],"limit":"92 KB","gzip":false},{"name":"popup.js","path":"popup.js","limit":"34 KB","gzip":false},{"name":"background.js (sw)","path":"background.js","limit":"12 KB","gzip":false}]`
Current: content-scripts sum **81.4 KB**, popup **30.4 KB**, background **10.3 KB**. **F-008 note:** when it splits `shared-utils.js`, add the new filenames to the `path` array — the 92 KB _group_ budget bounds the summed manifest payload, so the split stays green as long as total bytes don't balloon.

### Remaining knip ignores — each justified (leave in place)

config files (eslint/postcss×2/tailwind) = tool configs knip can't trace; `public/sw.js` = runtime-loaded, not imported; `gtag.ts`+`@types/gtag.js` = LIVE namespace import in providers.tsx (knip mis-flags `import * as`); `cryptoHelpers.ts` = LIVE via decryptJsonData.ts; argos/eslint/prettier/tailwind-forms deps = binaries/plugins knip doesn't see; `StoreButtons.tsx`,`capitalizeFirst.ts`, react-\* UI deps = **genuinely-suspicious, flagged as observations** (kept ignored to preserve green; deletion is next-cycle, not this fix).

### Branch-protection handoff (`gh api`, human-run, repo `DevinoSolutions/caramel`)

Required contexts after this fix: `lint`,`prettier`,`typecheck`,`knip`,`oxlint`,`Schema Drift`,`checks`,`E2E & Visual Regression (PR)`. For each of `main`,`dev`:
`gh api -X PUT repos/DevinoSolutions/caramel/branches/<b>/protection --input protection.json` where protection.json = `{"required_status_checks":{"strict":true,"contexts":["lint","prettier","typecheck","knip","oxlint","Schema Drift","checks","E2E & Visual Regression (PR)"]},"enforce_admins":true,"required_pull_request_reviews":{"required_approving_review_count":1},"restrictions":null}`. Verify current state first: `gh api repos/DevinoSolutions/caramel/branches/main/protection` (today: 404 "Branch not protected").

## Breaking changes

None. Deleted modules are Pages-Router (`NextApiRequest/Response`) with zero App-Router callers — knip whitelisted them _because_ they're unused (the ignore list is itself proof). `withAuth` importing live `@/lib/auth/auth` and `withRoles` importing `@/lib/prisma` is one-directional; deleting the fossils leaves those live modules untouched. No published/runtime consumer. New gates (oxlint/size-limit/husky) only affect contributors, not shipped code.

## Test strategy

Pinning FIRST (Step 1, on the pre-change tree): `fossil-removal.guard.test.ts` pins that the three KEEP-live siblings import-resolve — locking that the deletion doesn't collateral-nuke a live neighbor; after deletion it also asserts the 6 fossil paths are gone. No unit test can characterize the fossils themselves (dead code, no callers) — the real gates are structural. **"Green" = all of:** knip GREEN _truthfully_ (no fossil ignore entries), `type-check` clean, `oxlint` 0 errors, `size` within budget, `next build` succeeds, Playwright e2e unchanged, and a manual `.husky/pre-commit` dry-run passing all four gates. Post-fix, a Haiku re-runs the change-trace/3am empirical to confirm knip no longer lies.

## Rollback

One atomic commit → `git revert <sha>` restores fossils, deps (lockfile reverts), knip, and every config in one shot; deleted files recoverable from history. Each numbered step is a checkpoint — a failed step (e.g. oxlint surfaces a real bug) restarts from that step without losing prior pins. Branch protection is human/manual and lives outside the repo — nothing to revert there.

## Risk

Blast radius near-zero: deletions verified 3 ways (knip-whitelist = unused-proof, per-file grep = zero external callers, file reads = only self/doc refs). **Worst case:** a `import('@/lib/cors')`-style dynamic/string ref grep missed → caught by the Step 2 `next build` + e2e gate, error names the path. jsonwebtoken removal risk: zero imports found and better-auth carries its own JWT — build+e2e confirm. oxlint risk: may expose real correctness bugs (a win) or noisy rules → honest per-rule disable, never blanket. size-limit risk: budget too tight → CI red on legit growth; mitigated by headroom + split-invariant group budget. **Premises verified in code** (not assumed): all 6 fossil files exist; zero callers; `apiResponseNext.ts` live; `cryptoHelpers`/`gtag` live; jsonwebtoken/cors orphan; sizes measured; oxlint 1.73.0 / size-limit 12.1.0 confirmed via npm. **Assumed:** `.oxlintrc.json` schema shape — executor confirms against oxlint 1.73 at implement time.
