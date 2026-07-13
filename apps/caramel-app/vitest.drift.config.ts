import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { configDefaults, defineConfig } from 'vitest/config'

// F-001/F-006 (coupons repository-pattern migration) — the coupons_db
// structural drift gate runs every registered query in
// src/lib/couponsRepo.ts's `couponsQueryProbes` for real against a live
// COUPONS_DATABASE_URL (see tests/drift/coupons-schema.drift.ts). Separate
// config, mirroring vitest.eval.config.ts, for the same reason: this must
// NEVER run as part of `pnpm test` (F-004's vitest.config.ts only includes
// tests/unit/**), and it needs the exact same env-loading + server-only
// shim eval suites need — couponsRepo -> couponsDb -> env.ts imports
// `server-only`, which throws under a plain `tsx` run (no "react-server"
// export condition), so this can't be a standalone script either. Only
// THIS config's `include` collects `tests/drift/**/*.drift.ts`. Run via
// `pnpm --filter caramel-app check:coupons-schema` (local, reads this
// package's own .env) or `.github/workflows/coupons-schema-drift.yml`
// (workflow_dispatch only — see that file's comment for why).
//
// Local runs read COUPONS_DATABASE_URL (and DATABASE_URL/BETTER_AUTH_SECRET,
// needed only because env.ts eager-parses them at import time, never
// touched by the gate itself) from this package's own .env via Node's
// built-in env-file loader (Node >=20.12), same mechanism as
// vitest.eval.config.ts. CI has no .env file — the workflow sets
// COUPONS_DATABASE_URL directly in the job's `env:` block (the real
// secret) alongside throwaway DATABASE_URL/BETTER_AUTH_SECRET values.
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
        include: ['tests/drift/**/*.drift.ts'],
        exclude: configDefaults.exclude,
        setupFiles: ['./tests/setup.ts'],
        testTimeout: 30000,
        // DATABASE_URL/BETTER_AUTH_SECRET are dummies — the gate never
        // touches the auth DB, these only exist to satisfy env.ts's eager
        // parse (same pattern as vitest.config.ts's F-005 fixture).
        // COUPONS_DATABASE_URL is deliberately NOT listed here — unlike
        // vitest.eval.config.ts (which hardcodes a dummy because
        // cartClassifier never touches the DB), this gate's entire job IS
        // querying the real coupons DB, so its value must flow through
        // from the real environment (.env locally via loadEnvFile above,
        // the job env in CI) rather than being silently overridden by a
        // config-level default — a hardcoded value here would risk the
        // exact silent env drift this gate exists to catch.
        env: {
            DATABASE_URL:
                'postgresql://postgres:postgres@localhost:58005/caramel?schema=public',
            BETTER_AUTH_SECRET: 'vitest-fixture-better-auth-secret',
        },
    },
})
