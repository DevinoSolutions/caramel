import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { configDefaults, defineConfig } from 'vitest/config'

// F-012 — separate config so live-cost eval suites (evals/**/*.eval.ts)
// never run as part of the regular `pnpm test` / CI "unit" task: F-004's
// vitest.config.ts excludes `**/*.eval.*`, and only THIS config's
// `include` collects them. Run via `pnpm eval` (local) or
// .github/workflows/ai-evals.yml (CI).
//
// Local runs (`pnpm eval`) read OPENROUTER_API_KEY (and any OPENROUTER_MODEL
// override) from this package's own .env via Node's built-in env-file
// loader (Node >=20.12 — see https://nodejs.org/api/process.html#processloadenvfilepath).
// No dotenv-cli, no new dependency: PLAN-F-012.md's CR-9 prefers a
// dependency-free loader over adding one, and this keeps env-loading in
// ONE place instead of split between a package.json script and this file.
// CI has no .env file — ai-evals.yml sets OPENROUTER_API_KEY directly in
// the job's `env:` block, so this block is a silent no-op there
// (fs.existsSync guards process.loadEnvFile, which otherwise throws ENOENT
// on a missing path). loadEnvFile never overrides a var already present in
// process.env, so a real CI-supplied secret always wins over the file.
const envPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '.env',
)
if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath)
}

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: 'node',
        include: ['evals/**/*.eval.ts'],
        exclude: configDefaults.exclude,
        setupFiles: ['./tests/setup.ts'],
        testTimeout: 30000,
        // The live suite runs its whole dataset (up to ~40 sequential
        // OpenRouter calls) inside one `beforeAll` — testTimeout (per `it`)
        // stays at the plan-specified 30s, but the collector itself needs
        // a much larger budget so it's never killed before the (instant)
        // gate assertion runs. Still comfortably inside the CI job's
        // 15-minute timeout (.github/workflows/ai-evals.yml).
        hookTimeout: 5 * 60 * 1000,
        // env.ts (imported transitively via cartClassifier -> openrouter)
        // eager-parses process.env at import time and requires these 3 —
        // identical dummies to vitest.config.ts's (F-005). cartClassifier
        // never touches the DB or auth, so real values are never needed
        // here. OPENROUTER_API_KEY/OPENROUTER_MODEL are deliberately NOT
        // listed here — they must flow through from the real environment
        // (.env locally, the job env in CI), never a hardcoded default in
        // this config (see ai-evals.yml's own comment: hardcoding the
        // model here would risk exactly the silent code/deploy drift
        // F-012 exists to catch).
        env: {
            DATABASE_URL:
                'postgresql://postgres:postgres@localhost:58005/caramel?schema=public',
            COUPONS_DATABASE_URL:
                'postgresql://postgres:postgres@localhost:58005/caramel_coupons',
            BETTER_AUTH_SECRET: 'vitest-fixture-better-auth-secret',
        },
    },
})
