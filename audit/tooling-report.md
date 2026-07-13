# Stage-0 Deterministic Tooling Report — caramel @ 537547b (branch dev)

Run from repo root on Windows (Git Bash). Exclusions per `audit/exclusions.md` honored in all file-level stats. All commands actually executed; failures recorded verbatim, nothing simulated.

**Methodology note (applies to items 3, 7, 8):** this environment runs a transparent shell hook ("RTK", documented in the user's own global config) that rewrites/summarizes some commands before their output reaches the caller. Where that summarization looked lossy or suspect, it was cross-checked with `rtk proxy <cmd>` (documented escape hatch for raw/unfiltered execution) and/or scoped `pnpm --filter` re-runs. Every place this happened is called out explicitly below.

---

## HEADLINE

- **Tests:** NO TEST SUITE EXISTS. `pnpm test` ×2 — both exit 0, turbo matches 0 tasks ("No tasks were executed as part of this run"). Confirmed: no package defines a `test` script.
- **Type-check:** PASS. `pnpm -r run type-check` exit 0, 0 errors (caramel-app/tsc only; caramel-extension has no type-check script — plain JS, expected).
- **Lint:** Reproducible current state = **clean**: 0 errors / 191 warnings, all 191 in caramel-extension (CRLF + no-console), caramel-landing 0/0. A one-off first run showed exit 1 / 486 errors / 236 warnings sourced from `apps/caramel-app/.next/dev/**` build artifacts — NOT reproduced across 2 subsequent no-cache runs; flagged as a tooling/environment anomaly, not a source defect (full investigation in §3).
- **Knip (caramel-landing):** 1 unused exported type (`CouponRow`), 0 unused files, 0 unused deps. Exit 1 (knip's any-finding=nonzero convention).
- **Prettier:** FAIL — 13 unformatted files (9 caramel-app + 4 caramel-extension). Root cause assist: `.prettierrc.json`'s `tailwindConfigPath` key is invalid (silently ignored on every file, every run) — correct key is `tailwindConfig`.
- **pnpm audit --prod:** 83 vulnerabilities — **2 critical, 45 high, 30 moderate, 6 low**.
- **pnpm outdated -r:** 50 of 51 deps outdated. 15 notable majors incl. Prisma 6→7, TypeScript 5→7 (skips 6), Tailwind 3→4, ESLint 9→10; `react-awesome-button` is npm-**deprecated** (not just outdated).
- **Churn top-5 (18mo, path-normalized):** `apps/caramel-extension/shared-utils.js` (4529), `apps/caramel-extension/assets/styles.css` (4465), `.github/workflows/release.yml`→now `release-extension.yml` (3787), `apps/caramel-extension/popup.js` (2901), `apps/caramel-extension/background.js` (1547).
- **LOC top-5:** `apps/caramel-extension/shared-utils.js` (1536 — also #1 churn), `apps/caramel-extension/popup.js` (759), `apps/caramel-app/src/app/api/extension/oauth/route.ts` (595), `apps/caramel-app/src/components/OpenSourceSection.tsx` (470), `apps/caramel-app/src/components/coupons/coupons-section.tsx` (442).
- **CI:** 3 workflows (checks-app, checks-extension, release-extension). 16 unique secrets referenced, **0 phantom** (all exist), 2 orphaned/unused configured secrets (APPLE_APP_ID, APPLE_PROVISION_PROFILE). **Branch protection: NONE on main or dev** (both 404 "Branch not protected") — CI is advisory only, nothing gates merges.
- **Env validation at boot:** NO. No zod / no @t3-oss/env-nextjs / no custom validator anywhere in caramel-app. `.env.example` exists (19 documented vars) vs 38 distinct raw `process.env.*` reads in source.
- **AI surfaces:** YES — one real LLM surface: OpenRouter-backed cart classifier (`lib/openrouter.ts` + `lib/cartClassifier.ts` → `/api/classify-cart`, default model `openai/gpt-5-mini`). **Zero evals/tests** reference it.
- **Duplication (jscpd):** 65 clones, 5.55% duplicated lines / 5.35% duplicated tokens overall (125 files, 19,666 lines). Real signal concentrated in `.tsx` (42 clones, 11.80% lines) — marketing-section components and auth-page components copy-pasted rather than shared. The `markup` format's 47.58% is inert SVG logo-variant noise, not code.

---

## 1. `pnpm test` (run twice)

**Verdict: confirmed — zero matching tasks, both runs identical, exit 0.**

Run 1: exit `0`. Run 2: exit `0`. Both produced byte-identical structure:

```
turbo 2.5.4
• Packages in scope: caramel-extension, caramel-landing
• Running test in 2 packages
• Remote caching disabled

No tasks were executed as part of this run.

 Tasks:    0 successful, 0 total
Cached:    0 cached, 0 total
  Time:    727ms   (run 1)
  Time:    493ms   (run 2)
```

Root cause: `turbo.json` declares a `test` task, but neither `apps/caramel-app/package.json` nor `apps/caramel-extension/package.json` (nor the root) defines a `test` script — only `test:e2e` in both apps (Playwright for caramel-app, `scripts/test-extension.mjs` for caramel-extension), which `turbo run test` does not match. The hypothesis is confirmed: this is not a broken test run, it's a nonexistent one under this exact script name.

---

## 2. `pnpm -r run type-check`

**Verdict: pass, 0 errors.**

Exit `0`. Full output:

```
Scope: 2 of 3 workspace projects
apps/caramel-app type-check$ tsc --noEmit
apps/caramel-app type-check: Done
```

Only `caramel-landing` (apps/caramel-app) defines a `type-check` script; `caramel-extension` (plain JS) and the root package do not, which is expected. `tsc --noEmit` completed with 0 errors. (The "Scope: 2 of 3" line doesn't fully reconcile against only one package actually owning the script — recorded verbatim as an observed pnpm scope-counting quirk; it does not change the substantive result.)

---

## 3. `pnpm lint` (turbo run lint) — investigated in depth due to a major discrepancy

**Verdict: current reproducible state is clean (0 errors, 191 warnings, all in caramel-extension). A one-off first reading of 486 errors was traced to `.next` build artifacts and does not reproduce — treat as a tooling anomaly, not a source defect.**

**What happened, in order:**

1. First invocation of `pnpm lint`: **exit 1**. The environment's shell hook (RTK) rendered a condensed summary instead of raw ESLint output: `ESLint: 486 errors, 236 warnings in 57 files`, top rules `react-hooks/rules-of-hooks` (188×), `@next/next/no-assign-module-variable` (67×), `@typescript-eslint/no-explicit-any` (64×), `deprecation/deprecation` (41×), `@typescript-eslint/no-unused-vars` (26×), etc.
2. Investigating the hook's own (1 MiB-capped) tee log confirmed the flagged "files" were all real ESLint JSON results for real files on disk at that moment — but **every single one** of the ~34 recoverable file paths was under `apps/caramel-app/.next/dev/build/**` or `apps/caramel-app/.next/dev/server/**` (Turbopack chunk bundles containing vendored `@sentry`, `@better-auth`, `@opentelemetry`, `jose`, `rate-limiter-flexible`, the turbopack runtime itself, and compiled route files) — i.e. **build output, not source**. Zero real source paths, zero `caramel-extension` paths appeared.
3. To verify whether this reflects a real `.next`-not-ignored config gap, two independent fresh (no-cache) full re-runs were executed: plain `pnpm lint` again, and `npx turbo run lint --force` (cache forcibly bypassed). **Both exited 0**, `Tasks: 2 successful, 2 total`, both packages reported `cache miss, executing` (i.e. genuinely re-ran, not replayed).
4. Per-package breakdown via `pnpm --filter <pkg> lint`:
    - `caramel-landing` (apps/caramel-app): **0 problems**, exit 0, 4-line empty output.
    - `caramel-extension`: **191 problems (0 errors, 191 warnings)**, exit 0. 189× `prettier/prettier` "Delete `␍`" in `cart-signals.js` (CRLF line endings — this file has Windows line endings while the rest of the repo/prettier config expects LF) + 2× `no-console` (`background.js:185`, `shared-utils.js:49`). 189 of 191 auto-fixable via `--fix`.
5. Directly tested whether `.next/**` is actually ignored right now: `npx eslint .next` → _"all of the files matching the glob pattern '.next' are ignored"_; explicitly targeting one specific chunk file → _"File ignored because of a matching ignore pattern."_ **Confirms `.next/**` is correctly excluded under the current flat config** (`eslint-config-next`'s bundled ignores), so a config gap does not explain step 2.

**Conclusion:** the true, currently-reproducible lint health of the repo is 0 errors / 191 warnings (caramel-extension only). The 486-error reading was real console output (not fabricated) but is not reproducible and cannot be attributed to a standing config defect — most likely either the shell hook's own auxiliary summarization scan running under different conditions than the real `turbo run lint` task, or a transient state of `apps/caramel-app/.next/dev` (which is a live Next.js dev-build cache whose contents were observed to differ between invocations, last modified during this session). Either way, **something in this environment can make one lint invocation look catastrophically broken and the very next look clean with no source change in between** — worth a mention as an operability/CI-trust risk even though it isn't a codebase defect per se.

---

## 4. `pnpm --filter caramel-landing knip`

**Verdict: very clean — 1 unused export, 0 unused files, 0 unused deps.**

Exit `1` (knip's convention: any finding → nonzero exit, regardless of severity).

```
Unused exported types (1)
CouponRow  type  src/lib/couponsDb.ts:34:13
```

No other categories (unused files, unused dependencies, unused exports, duplicate exports, unlisted deps) reported anything.

---

## 5. `pnpm prettier-check`

**Verdict: fail — 13 unformatted files total, plus a repo-wide silently-broken prettier option.**

Combined `pnpm prettier-check` (turbo): exit `1`.

- **caramel-extension**: `Code style issues found in 4 files` — `cart-signals.js`, `index.html`, `manifest-firefox.json`, `package.json`.
- **caramel-landing** (verified standalone, exit 1): `Code style issues found in 9 files` — `package.json`, `src/app/api/classify-cart/route.ts`, `src/app/api/coupons/filters/route.ts`, `src/app/api/coupons/stats/route.ts`, `src/app/api/extension/supported-stores/route.ts`, `src/lib/capitalizeFirst.ts`, `src/lib/cartClassifier.ts`, `src/lib/couponsDb.ts`, `src/lib/openrouter.ts`.
- **Total: 13 files** need `prettier --write`.

**Associated config bug (verified):** every single file check in both packages emits `[warn] Ignored unknown option { tailwindConfigPath: "./apps/caramel-app/tailwind.config.ts" }`. Root `.prettierrc.json` (line 11) sets `"tailwindConfigPath"`, but `prettier-plugin-tailwindcss@0.6.14`'s own README documents the option as `tailwindConfig` (confirmed by reading `node_modules/prettier-plugin-tailwindcss/README.md`). The option has silently never taken effect — Tailwind class-sorting falls back to auto-detecting a config from the prettier config's own directory (the empty-stub root `tailwind.config.js: { content: [] }`) instead of the real `apps/caramel-app/tailwind.config.ts`.

---

## 6. `pnpm audit --prod`

**Verdict: 83 vulnerabilities, including 2 critical.**

Exit `1`.

```
83 vulnerabilities found
Severity: 6 low | 30 moderate | 45 high | 2 critical
```

(Per task scope, severities only — no package-level detail captured for this item.)

---

## 7. `pnpm outdated -r`

**Verdict: 50 of 51 workspace dependencies are outdated; 15 notable majors, plus one fully deprecated package.**

Exit `0`. `50 outdated packages (of 51)`. The default hook summary only sampled ~10 rows per call; the complete 50-row table was retrieved via `rtk proxy pnpm outdated -r` (raw/unfiltered execution) and manually reviewed in full. Top 15 notable majors/deprecations:

| #   | Package                           | Current → Latest       | Note                                                               |
| --- | --------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| 1   | `react-awesome-button`            | 7.0.5 → **Deprecated** | Not just outdated — deprecated on npm entirely                     |
| 2   | `@prisma/client`                  | 6.14.0 → 7.8.0         | major                                                              |
| 3   | `prisma`                          | 6.14.0 → 7.8.0         | major (paired CLI)                                                 |
| 4   | `typescript`                      | 5.9.2 → 7.0.2          | major, skips v6 entirely                                           |
| 5   | `tailwindcss`                     | 3.4.17 → 4.3.2         | major, v3→v4 is a full rewrite                                     |
| 6   | `eslint`                          | 9.31.0 → 10.7.0        | major                                                              |
| 7   | `lint-staged`                     | 16.4.0 → 17.0.8        | major                                                              |
| 8   | `@argos-ci/cli`                   | 3.2.1 → 6.2.0          | major, 3 majors behind                                             |
| 9   | `@argos-ci/playwright`            | 6.3.3 → 7.3.5          | major                                                              |
| 10  | `web-ext`                         | 8.8.0 → 10.5.0         | major, skips v9                                                    |
| 11  | `knip`                            | 5.70.2 → 6.26.0        | major                                                              |
| 12  | `@react-email/render`             | 1.2.1 → 2.1.0          | major                                                              |
| 13  | `react-infinite-scroll-component` | 6.1.1 → 7.2.1          | major                                                              |
| 14  | `@types/node`                     | 24.3.0 → 26.1.1        | 2 majors                                                           |
| 15  | `prettier-plugin-tailwindcss`     | 0.6.14 → 0.8.0         | 0.x breaking-by-convention; directly relevant to the §5 config bug |

Also notable non-major but large jumps seen in the full table: `@sentry/nextjs` 10.38.0→10.65.0, `@better-auth/prisma-adapter`/`better-auth` 1.5.3→1.6.23, `@types/node` as above, `sass` 1.90.0→1.101.0.

---

## 8. Git churn (18 months, `--numstat`, aggregated per file)

**Verdict: caramel-extension's shared JS/CSS files dominate churn by a wide margin; the repo underwent a full directory restructure and a backend service was removed within the window.**

Window: 2025-01-11 → 2026-07-03 (551 commits). The shell hook truncated the naive `git log --numstat` capture to 50 lines; the complete 1,838-line numstat was retrieved via `rtk proxy` and aggregated locally (added+deleted per file, exclusions applied per `audit/exclusions.md` + lockfiles/public assets/migrations per task instruction).

**Methodology note:** the repo was restructured at some point in-window from a flat layout (`caramel-landing/`, `caramel-extension/`, `caramel-backend/` as top-level dirs) into the current `apps/*` pnpm workspace. `git log --numstat` doesn't bridge that rename, so raw per-path aggregation would double-count/split real per-file history. I normalized the one clean, mechanical, verified 1:1 case — `caramel-extension/` → `apps/caramel-extension/` (pure directory move, same filenames) — into single entries below. I did **not** attempt to merge `caramel-landing/*.jsx` history into `apps/caramel-app/*.tsx`, because that migration also changed file extensions and moved Pages Router → App Router; a spot-check confirmed merging wouldn't materially reorder the top-25 anyway. `.github/workflows/release.yml` is a historical filename — the equivalent file today is `release-extension.yml`.

Also found: **`caramel-backend/`** (a standalone Node service with its own `index.js`, `package.json`, and a committed JetBrains `.idea/` directory) existed early in the window, last touched 2025-01-24 ("caramel landing + backend"), and has been **fully removed** — 0 files remain in the current tree. Its functionality appears to have been absorbed into `apps/caramel-app/src/app/api/**`.

**Top 25 by churn (added+deleted, exclusions applied):**

| Churn | +/-       | File                                                                                                                         |
| ----- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 4529  | 2829/1700 | apps/caramel-extension/shared-utils.js                                                                                       |
| 4465  | 2621/1844 | apps/caramel-extension/assets/styles.css                                                                                     |
| 3787  | 2058/1729 | .github/workflows/release.yml _(now release-extension.yml)_                                                                  |
| 2901  | 1821/1080 | apps/caramel-extension/popup.js                                                                                              |
| 1547  | 628/919   | apps/caramel-extension/background.js                                                                                         |
| 1529  | 974/555   | apps/caramel-extension/caramel-content.css                                                                                   |
| 1312  | 698/614   | caramel-landing/src/components/SupportedSection.jsx _(historical; now apps/caramel-app/src/components/SupportedSection.tsx)_ |
| 1308  | 858/450   | caramel-landing/src/components/FeaturesSection.jsx _(historical; now .tsx)_                                                  |
| 1203  | 819/384   | caramel-landing/src/components/OpenSourceSection.jsx _(historical; now .tsx)_                                                |
| 1166  | 771/395   | apps/caramel-extension/UI-helpers.js                                                                                         |
| 874   | 478/396   | caramel-landing/src/pages/index.jsx _(historical, Pages Router)_                                                             |
| 859   | 727/132   | apps/caramel-app/src/app/api/extension/oauth/route.ts                                                                        |
| 682   | 515/167   | apps/caramel-app/src/app/(marketing)/sources/page.tsx                                                                        |
| 635   | 338/297   | apps/caramel-app/src/app/(auth)/signup/page.tsx                                                                              |
| 619   | 487/132   | caramel-landing/src/components/HeroSection.jsx _(historical; now .tsx)_                                                      |
| 592   | 296/296   | caramel-landing/src/pages/sources.jsx _(historical, Pages Router)_                                                           |
| 582   | 418/164   | caramel-landing/src/components/Doodles.jsx _(historical; now .tsx)_                                                          |
| 580   | 511/69    | apps/caramel-app/src/components/coupons/coupons-section.tsx                                                                  |
| 497   | 376/121   | caramel-landing/src/components/PrivacyPolicy.jsx _(historical; now .tsx)_                                                    |
| 469   | 379/90    | apps/caramel-app/src/app/(auth)/login/LoginPageClient.tsx                                                                    |
| 462   | 231/231   | caramel-landing/src/pages/signup.jsx _(historical, Pages Router)_                                                            |
| 418   | 391/27    | apps/caramel-app/emails/EmailLayout.tsx                                                                                      |
| 402   | 217/185   | apps/caramel-extension/index.html                                                                                            |
| 397   | 19/378    | apps/caramel-app/src/pages/sources.tsx _(historical, TS Pages Router, pre-App-Router)_                                       |
| 382   | 382/0     | caramel-landing/src/components/WhyNot.tsx _(historical; already .tsx)_                                                       |

---

## 9. LOC — top 20 largest tracked source files (ts/tsx/js/mjs/cjs)

**Verdict: `apps/caramel-extension/shared-utils.js` is both the single largest source file (1536 lines) and the #1 churn hotspot from §8 — a concrete "god file" risk.**

120 tracked files matched (after exclusions):

| Lines | File                                                        |
| ----- | ----------------------------------------------------------- |
| 1536  | apps/caramel-extension/shared-utils.js                      |
| 759   | apps/caramel-extension/popup.js                             |
| 595   | apps/caramel-app/src/app/api/extension/oauth/route.ts       |
| 470   | apps/caramel-app/src/components/OpenSourceSection.tsx       |
| 442   | apps/caramel-app/src/components/coupons/coupons-section.tsx |
| 385   | apps/caramel-app/src/components/FeaturesSection.tsx         |
| 376   | apps/caramel-extension/UI-helpers.js                        |
| 364   | apps/caramel-app/emails/EmailLayout.tsx                     |
| 348   | apps/caramel-app/src/app/(marketing)/sources/page.tsx       |
| 308   | apps/caramel-extension/scripts/test-extension.mjs           |
| 292   | apps/caramel-app/src/components/PricingSection.tsx          |
| 289   | apps/caramel-app/src/components/PrivacyPolicy.tsx           |
| 285   | apps/caramel-app/e2e/auth-flows.spec.ts                     |
| 275   | apps/caramel-extension/background.js                        |
| 267   | apps/caramel-app/src/app/(auth)/signup/SignupPageClient.tsx |
| 257   | apps/caramel-app/src/components/Doodles.tsx                 |
| 247   | apps/caramel-app/src/components/HeroSection.tsx             |
| 242   | apps/caramel-app/src/layouts/Header/Header.tsx              |
| 232   | apps/caramel-app/src/components/coupons/coupon-filters.tsx  |
| 228   | apps/caramel-app/src/app/(auth)/login/LoginPageClient.tsx   |

---

## 10. CI inventory

**Verdict: 3 workflows, CI is real but purely advisory — zero branch protection means nothing actually blocks a merge; secrets are clean (0 phantom) with 2 harmless orphans.**

### `.github/workflows/checks-app.yml` — "CI Checks – App"

- **Triggers:** push to `main`/`dev`; PR into `main`/`dev`.
- **Jobs:**
    - `test-matrix` (always): matrix over `["lint","prettier","typecheck","knip"]`, each running the corresponding `pnpm` script inside `apps/caramel-app`, plus `pnpm doctor` dependency validation and conditional Prisma client generation for the typecheck leg.
    - `schema-drift` (PR only): spins up ephemeral Postgres 15, runs `prisma validate` + `prisma migrate diff` both directions (migrations⇄schema, migrations⇄DB) to catch drift.
    - `e2e-pr` (PR only): ephemeral Postgres, installs Playwright+chromium, generates Prisma client, applies migrations, runs `pnpm test:e2e` against a locally-started dev server, uploads Playwright report, reports to Argos for visual regression.
    - `e2e-push` (push only): runs `pnpm test:e2e` against the **deployed** dev/prod baseline (`dev.grabcaramel.com` / `grabcaramel.com`), no local server, uploads report, Argos visual regression.
- **Secrets referenced:** `ARGOS_TOKEN`.

### `.github/workflows/checks-extension.yml` — "CI Checks – Extension"

- **Triggers:** push to `main`/`dev`; any PR.
- **Jobs:** single `lint_and_build` job — install, `pnpm run lint`, `pnpm run prettier-check`. No build/test/package step.
- **Secrets referenced:** none.

### `.github/workflows/release-extension.yml` — "Release – Extension"

- **Triggers:** `pull_request` `closed` into `main` (gated `if: github.event.pull_request.merged == true`).
- **Jobs:**
    - `package`: builds and zips the extension, uploads as artifact.
    - `publish_chrome` (needs `package`, skippable via `skip=chrome` in PR title): uploads (not auto-publishes) to Chrome Web Store.
    - `publish_safari` (needs `package`, skippable via `skip=apple` in PR title, macOS runner): full Xcode pipeline — generates Safari icons, imports distribution + dev certs, queries App Store Connect/TestFlight for current build numbers, auto-bumps version (major/minor/patch inferred from PR title keywords), archives + exports + uploads both macOS and iOS Safari-extension targets.
- **Secrets referenced:** `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_KEY_BASE64`, `APPLE_TEAM_ID`, `APPLE_CERT_P12`, `APPLE_CERT_PASSWORD`, `APPLE_DEV_CERT_P12`, `APPLE_DEV_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_PASSWORD`, `KEYCHAIN_PASSWORD`.

### Secrets: referenced vs. actual (`gh secret list`)

16 unique `secrets.*` names referenced across all 3 workflows. All 18 configured repo secrets:
`APPLE_APP_ID, APPLE_APP_PASSWORD, APPLE_CERT_P12, APPLE_CERT_PASSWORD, APPLE_DEV_CERT_P12, APPLE_DEV_CERT_PASSWORD, APPLE_ID, APPLE_PROVISION_PROFILE, APPLE_TEAM_ID, ARGOS_TOKEN, ASC_API_KEY_BASE64, ASC_ISSUER_ID, ASC_KEY_ID, CHROME_CLIENT_ID, CHROME_CLIENT_SECRET, CHROME_EXTENSION_ID, CHROME_REFRESH_TOKEN, KEYCHAIN_PASSWORD`.

- **Phantom (referenced but don't exist): 0.** Every referenced secret exists.
- **Orphaned (configured but never referenced): 2** — `APPLE_APP_ID`, `APPLE_PROVISION_PROFILE` (likely dead from before the workflow switched to `CODE_SIGN_STYLE=Automatic` provisioning).

### Branch protection

- `main`: `gh api repos/DevinoSolutions/caramel/branches/main/protection` → **HTTP 404 "Branch not protected"**.
- `dev`: same call → **HTTP 404 "Branch not protected"**.
- **Neither branch has any protection rule.** No required status checks, no required reviews, no restrictions on force-push/deletion. The 3 CI workflows above run, but nothing in GitHub actually requires them to pass before merge.

---

## 11. Env hygiene (apps/caramel-app)

**Verdict: no boot-time env validation exists.**

- `zod` is **not** a dependency of `apps/caramel-app` (checked `package.json` `dependencies`/`devDependencies` directly).
- `@t3-oss/env-nextjs` is **not** present either.
- No file named `env.ts`/`env.mjs` anywhere in `apps/caramel-app`; repo-wide grep for `envSchema|parseEnv|validateEnv|z\.object\(` inside `apps/caramel-app/src` returns nothing; no `from 'zod'` imports anywhere in the app.
- `next.config.mjs` reads `process.env.NODE_ENV` / `process.env.CI` directly with no schema.
- **What does exist:** `apps/caramel-app/.env.example` (tracked, documents 19 vars: `DATABASE_URL`, `JWT_SECRET`, `BCRYPT_SALT_ROUNDS`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `NEXT_PUBLIC_BASE_URL`, `GOOGLE_CLIENT_ID/SECRET`, `APPLE_CLIENT_ID/SECRET/REDIRECT_URI`, `NEXT_PUBLIC_SENTRY_DSN`, `USESEND_BASE_URL/API_KEY/FROM_EMAIL/FROM_NAME`, `OPENROUTER_API_KEY/MODEL`, `NODE_ENV`), plus `apps/caramel-app/scripts/ci-env.ts` (invoked as `setup:ci-env` in CI to materialize a minimal env for the e2e-pr job).
- Source code reads **38 distinct** `process.env.*` keys directly (more than `.env.example` documents), with no central schema and no fail-fast-at-boot behavior — a missing/misconfigured var surfaces wherever it's first dereferenced at runtime, not at startup.
- `apps/caramel-extension` is a plain browser extension (no server-side env concept) — n/a.
- Only `local-dev/.env.ports` is a tracked `.env*` file repo-wide; no real `.env` with secrets is tracked (confirmed via `git ls-files`).

---

## 12. AI surfaces

**Verdict: one real LLM integration exists, with zero eval/test coverage.**

Repo-wide case-insensitive grep for `openai|anthropic|claude|gpt-|gemini|\bllm\b|completion` (exclusions honored) → 6 raw hits, of which 2 are genuine:

- `apps/caramel-app/src/lib/openrouter.ts:1-2` — generic OpenRouter chat-completion client: `OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'`, `DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-5-mini'`. Configurable temperature/maxTokens/JSON-mode, 8s default timeout, throws `OpenRouterError` on missing key/non-OK/empty response.
- `apps/caramel-app/src/lib/cartClassifier.ts:116` — "llm returned non-json" — this module (171 lines) calls the above to classify shopping-cart contents, exposed via `apps/caramel-app/src/app/api/classify-cart/route.ts`.

The other 4 hits are false positives (generic English/native-API vocabulary, not AI-related):

- `apps/caramel-app/src/app/api/extension/oauth/route.ts:199` — comment, "OAuth flow initiation, not **completion**".
- `apps/caramel-extension/apple-extension/Shared (Extension)/SafariWebExtensionHandler.swift:39` — Swift `completionHandler` callback (standard native API pattern).
- `apps/caramel-extension/popup.js:333` — comment, "ensure **completion**" (a Promise wrapper).

**Eval/test coverage: zero.** Grepped `*.test.*`, `*.spec.*`, and `apps/caramel-app/e2e/**` for `cartClassifier|openrouter` — no matches. This is a real production LLM surface (cart classification, gating a user-facing feature) with no automated evals or tests of any kind.

---

## 13. Duplication quick-scan (jscpd, `--min-tokens 50`)

**Verdict: 65 clones, 5.55% duplicated lines overall; the real actionable signal is concentrated in caramel-app's TSX components (marketing sections + auth pages), not in the extension.**

`npx jscpd` ran successfully (auto-installed `jscpd@5.0.12` on the fly, no fetch failure — the documented fallback path was not needed). Exit 0.

**Summary table:**

| Format     | Files   | Lines      | Clones | Dup. lines       | Dup. tokens       |
| ---------- | ------- | ---------- | ------ | ---------------- | ----------------- |
| css        | 4       | 1610       | 2      | 24 (1.49%)       | 115 (0.82%)       |
| javascript | 9       | 3659       | 2      | 23 (0.63%)       | 117 (0.77%)       |
| json       | 6       | 297        | 1      | 19 (6.40%)       | 56 (6.51%)        |
| markup     | 19      | 433        | 12     | 206 (47.58%)     | 1019 (41.57%)     |
| swift      | 4       | 165        | 0      | 0                | 0                 |
| **tsx**    | 41      | 5917       | **42** | **698 (11.80%)** | **3435 (12.54%)** |
| typescript | 41      | 3111       | 6      | 122 (3.92%)      | 549 (3.93%)       |
| yaml       | 1       | 4474       | 0      | 0                | 0                 |
| **Total**  | **125** | **19,666** | **65** | **1092 (5.55%)** | **5291 (5.35%)**  |

**Where the real signal is:**

- **tsx (dominant, actionable):** heavy cross-component duplication among caramel-app's marketing sections — `FeaturesSection.tsx` ↔ `OpenSourceSection.tsx` (multiple blocks, one up to 53 lines/196 tokens) ↔ `SupportedSection.tsx` ↔ `PricingSection.tsx` ↔ `WhyNot.tsx` — plus near-identical page wrappers: `app/(auth)/login/page.tsx` is a 33-line/104-token clone of `signup/page.tsx`, `verify/page.tsx`, `(marketing)/coupons/page.tsx`, and `(marketing)/privacy/page.tsx` (same 33 lines repeated across **5** route files), and `LoginPageClient.tsx` ↔ `SignupPageClient.tsx` ↔ `VerifyPageClient.tsx` share several 10-17 line blocks. These are exactly the components flagged as large (§9) and high-churn (§8) — consistent evidence of a maintainability hotspot.
- **typescript:** `apps/caramel-app/src/app/api/extension/oauth/route.ts` duplicates **itself** (lines 269-339 ≈ lines 516-582, 71 lines/258 tokens) — a strong "extract a function" signal in the largest API route file. Also `lib/apiResponseNext.ts` ↔ `lib/securityHelpers/apiResponse.ts` — two parallel response-helper modules.
- **markup (47.58% — not actionable):** all 12 clones are among SVG logo color/size variants under `assets/Caramel Logos/svgs/**` (e.g. `16x16 Caramel Orange BG.svg` vs `16x16 Caramel White BG.svg`) — near-identical by design as brand-asset exports, not a code-duplication problem.
- **json:** `manifest-firefox.json` ↔ `manifest.json` — expected/inherent for multi-browser extension manifests.
- **javascript (minor):** `UI-helpers.js` ↔ `popup.js`, 15 lines/50 tokens.
