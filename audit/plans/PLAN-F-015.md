# PLAN-F-015 — Broken/stray artifacts: Firefox amazon.js, strays, name-lie, dead prettier key

**Finding:** F-015 (Medium, conf 0.95, category code_health) · **Effort:** S · **Wave:** 4 · **Sequence:** 12 · **Depends-on:** F-004 (vitest for the integrity check), F-009 (oxlint/husky landed). **Interacts:** F-014 (lockfiles, AFTER me — keep lockfile touch = **0**).

## Premise check (verified in code @0c0a991)

- **amazon.js:** git history `e3109f5 chore(extension): remove orphaned amazon.js (no longer in manifest)` — it existed and was **intentionally deleted**. Chrome `manifest.json` = clean; `manifest-firefox.json:49` is **stale** (still lists it). Every other referenced ext file exists (verified). → **remove the entry, do not restore.**
- `local-dev/verify_test_small3.txt`: **tracked** (confirmed in `git ls-files`).
- **`nul`: NOT tracked in HEAD** (`git ls-files` shows only verify_test_small3.txt + amazon PNGs). Finding's "tracked `nul` file" sub-claim is **CORRECTED** → gitignore only, no delete.
- `apps/caramel-app/package.json:2` = `caramel-landing`; the **complete** reference set = that line + `checks-app.yml:51,185,188,191,243`. **pnpm-lock.yaml = 0 refs** (importers keyed by path `apps/caramel-app`, not by name). turbo.json/root package.json/nixpacks.toml: none.
- `.prettierrc.json:11` = `tailwindConfigPath` (**invalid key** → class-sorting never runs). Correct key = **`tailwindConfig`** (context7-confirmed; paths resolve relative to the prettierrc = repo root, so the value stays unchanged).

## Executive summary

Five mechanical fixes + one new CI check, **one commit**. Delete 1 stray, gitignore `nul`, drop `amazon.js` from the Firefox manifest, rename package `caramel-landing`→`caramel-app` (+5 workflow refs), fix the prettier key (**activates class-sorting → large but behavior-neutral tsx/html reformat**), and add a root-allowlist + manifest-integrity check proven **RED-then-GREEN**. Not breaking (rename atomic; lockfile untouched). **Riskiest:** the prettier-write class-order churn (Argos is the guard).

## Scope

**Delete:** `local-dev/verify_test_small3.txt` (`git rm`).
**Modify:**

- `.gitignore` — append `nul` (do **NOT** delete the local file: Windows reserved name, not the repo's business).
- `apps/caramel-extension/manifest-firefox.json:49` — drop `"amazon.js"` → `["shared-utils.js","UI-helpers.js","inject.js"]`.
- `apps/caramel-app/package.json:2` — `"caramel-landing"` → `"caramel-app"`.
- `.github/workflows/checks-app.yml:51,185,188,191,243` — `--filter caramel-landing` → `--filter caramel-app`.
- `.prettierrc.json:11` — key `tailwindConfigPath` → `tailwindConfig` (value unchanged).
- (mechanical) `pnpm prettier-write` → commit the now-active class-order reformat.
  **Create:** repo-integrity check + CI wiring (Approach).
  **OUT of scope (new-finding candidates, do NOT fix here):** `apple-extension/Caramel.xcodeproj/project.pbxproj` still references deleted `amazon.js` (6 refs, breaks Safari build); firefox manifest missing `cart-signals.js` that chrome ships (content-script divergence); root `tailwind.config.js` = `{content:[]}` empty stray; lockfile consolidation (F-014).

## Approach

- **amazon.js → remove, not restore:** history shows deliberate deletion; chrome manifest already dropped it; no recoverable live file.
- **`nul` → gitignore-only:** not tracked, local Windows artifact; deleting a reserved name isn't the repo's job. Records the correction.
- **Rename atomic in one commit:** pnpm importers are path-keyed (`apps/caramel-app`), not name-keyed → **no lockfile edit, no `pnpm install`** (verified 0 lockfile refs). CI's `pnpm install --frozen-lockfile` is the consistency guard.
- **Prettier key:** `tailwindConfig` value stays `./apps/caramel-app/tailwind.config.ts` (resolves from prettierrc dir = root). Activation reorders classes across `.tsx/.jsx/.html`; **behavior-neutral** (order ≠ CSS specificity); **Argos visual is the outer proof**. Executor confirms the key is live **empirically**: post-fix `prettier --check` reports class diffs (a still-wrong key = silent no-op, unchanged).
- **Integrity check (rules-become-checks):** one module doing (1) root tracked files ⊆ allowlist; (2) every `.js/.css/.html` referenced by `manifest.json` + `manifest-firefox.json` + `index.html` exists on disk (paths relative to `apps/caramel-extension/`). **Preferred home:** an F-004 vitest test in the app (`…/repo-integrity.test.ts`) resolving repo root, wired to the checks-app `test` task ("if cleaner"). **Fallback:** `apps/caramel-extension/scripts/verify-manifests.mjs` (plain-`.mjs`, extension convention) wired as a step in `checks-extension.yml`, plus a small root-allowlist step in `checks-app.yml`. Seed the allowlist from the current clean root set (`git ls-files` depth-1 minus strays: `.gitignore .prettierignore .prettierrc.json eslint.config.mjs LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml README.md tailwind.config.js turbo.json`).

## Sequencing (each step ends with its check)

1. **Write the integrity check FIRST** on the current tree (amazon.js still listed). Run → **manifest assertion FAILS on amazon.js** — proves it catches the bug. ✓ red as designed. **[the required RED proof]**
2. Remove `amazon.js` from `manifest-firefox.json:49`. Re-run → **GREEN** (all other refs verified present). ✓ green. **[checkpoint A]**
3. `git rm local-dev/verify_test_small3.txt`; append `nul` to `.gitignore`. ✓ `git check-ignore nul` matches; tree clean of both.
4. Rename package `name` + the 5 workflow `--filter` refs. ✓ `git grep -n caramel-landing -- . ':!audit'` = 0 hits. Do **NOT** run install; confirm `git grep -c caramel-landing pnpm-lock.yaml` = 0 (name not lockfile-recorded → no edit needed). If CI frozen-install later complains, run `pnpm install --lockfile-only` as the minimal delta and note it for F-014 (expected: no change).
5. Fix `.prettierrc.json` key → run `pnpm prettier-write`. ✓ `prettier --check` green AND `git diff` shows class-order reordering in tsx (proves activation). **[checkpoint B]**
6. Wire the check into CI (chosen home). ✓ the workflow step runs green locally (`node …/verify-manifests.mjs` or `pnpm --filter caramel-app test`).

## Breaking changes

- **Package rename** breaks `pnpm --filter caramel-landing` — all 5 uses are in `checks-app.yml`, updated in the same commit → **no window**. Dokploy/nixpacks build by path + `pnpm run build`, not the filter name → unaffected (verified).
- **Prettier activation** rewrites class order in every `.tsx/.jsx/.html` on first `prettier-write` — large diff, **zero rendering change** (Argos confirms). No consumer contract changes.
- **Firefox manifest** fix turns a currently-broken content-script load into a working one.

## Test strategy

- **The manifest-integrity check IS the pin** — authored red (step 1, catches amazon.js), then green (step 2). This is the mandated rules-become-checks proof; all other refs verified present, so removing amazon.js alone flips it green.
- **Root allowlist** guards future strays (would have caught a tracked `nul`).
- **Prettier churn** guarded by existing **Playwright + Argos/Snapvisor** visual regression (identical rendering pre/post).
- **Rename** guarded by CI itself (a stale `--filter` fails fast) + step-4 grep = 0.
- **"Green" =** integrity check green; `pnpm -r lint` + `prettier-check` green; workflows reference `caramel-app` only; Argos = no visual diffs.

## Rollback

Single commit `fix(F-015): remove stray/broken artifacts, rename app package, activate tailwind sort`. Internal checkpoints A (manifest+check) and B (rename+prettier) let a failed step restart. Revert = `git revert <sha>` (restores manifest entry, package name, prettier key together; the large prettier diff reverts cleanly — pure formatting). No data/deploy state touched.

## Risk

- **Blast radius:** config/manifest/workflows + a repo-wide formatting pass. Worst case: `prettier-write` reorders a class in a way Argos flags — investigate that one component; order shouldn't change render, so a real diff implies a pre-existing specificity foot-gun → new finding, don't hand-tune. Early warning: an Argos diff, or a CI `--filter` failure = a missed rename ref.
- **Verified in code:** amazon.js history + chrome-manifest cleanliness, existence of every referenced ext file, `nul`-not-tracked, the full `caramel-landing` ref set, 0 lockfile refs, nixpacks build-by-path, the prettier key (context7). **Assumed:** F-004's vitest layout (fallback to `.mjs` if it can't reach repo root cleanly); Argos wiring intact (repo facts).
