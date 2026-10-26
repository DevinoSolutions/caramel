import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { configDefaults, defineConfig } from 'vitest/config'

// W1 (trust loop) — integration harness for the app-owned coupon_signals
// table. Unlike the unit suite (which mocks prisma), these run the REAL prisma
// client against a live local Postgres (compose's :28005 locally, or CI's
// postgres service). Separate config + a `tests/integration/**/*.itest.ts`
// glob for the same reason vitest.drift.config.ts is separate: `pnpm test`
// (the unit runner, F-004) includes ONLY tests/unit/** and CI's unit job has
// no DB, so a DB-touching test swept into it would hang. Run via
// `pnpm --filter caramel-app test:integration` after a `prisma migrate deploy`
// (the harness/CI applies migrations first).
//
// DATABASE_URL is read from this package's own .env via Node's built-in
// env-file loader (Node >=20.12) — the SAME real value `prisma migrate` uses,
// so the client and the migrations agree on which database they touch. It is
// deliberately NOT hardcoded in a `test.env` block below: a dummy there would
// override the real connection string and silently point the client at a
// database that was never migrated (the exact trap vitest.drift.config.ts
// documents). couponSignals.ts → prisma imports no env.ts, so no other env
// vars are needed here.
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
        include: ['tests/integration/**/*.itest.ts'],
        exclude: configDefaults.exclude,
        // Run the integration FILES serially (one shared local Postgres). Vitest
        // defaults to parallel file execution, which forces every suite to scope
        // its assertions around whatever another file might transiently write
        // (see coupons-read.itest.ts's defensive id-filtering / lower bounds).
        // bridge-sync.itest.ts MUST publish a store_config carrying coupon_input
        // + apply_button xpaths — which is EXACTLY listSupportedStoreConfigs'
        // filter — so under parallel execution it would race coupons-read's exact
        // store_config assertion. Serial execution makes each file's afterAll
        // cleanup a real isolation boundary: a file never observes another's
        // in-flight rows, so no suite can perturb another (W4-D4).
        fileParallelism: false,
        // server-only shim — MANDATORY in any config that imports app modules:
        // a transitively-imported module may `import 'server-only'`, which
        // throws under vitest without this (see tests/setup.ts).
        setupFiles: ['./tests/setup.ts'],
        testTimeout: 30000,
    },
})
