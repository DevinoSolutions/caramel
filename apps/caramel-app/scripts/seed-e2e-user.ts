// CI/local runner for e2e/support/seed-user.ts — creates the verified test
// user the EXTENSION e2e suite logs in with (checks-extension.yml's e2e job;
// see apps/caramel-extension/scripts/test-extension.mjs). Same two-step shape
// the app's own E-05 spec uses: real signup API + a test-only email_verified
// DB flip (all the reasoning lives in seed-user.ts's header).
//
// Run: pnpm --filter caramel-app seed:e2e-user  (app must be up on BASE_URL,
// DATABASE_URL must point at the migrated e2e Postgres — .env provides both
// in CI via setup:ci-env).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedVerifiedUser } from '../e2e/support/seed-user'

// tsx does not auto-load env files — load this package's .env (written by
// setup:ci-env in CI) so DATABASE_URL reaches the email_verified flip, same
// guarded pattern as playwright.config.ts / vitest.integration.config.ts.
const envPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../.env',
)
if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath)
}

const baseURL =
    process.env.E2E_SEED_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    'http://localhost:28000'

// test@caramel.dev / test1234 are the extension suite's documented fixture
// credentials (test-extension.mjs TEST_EMAIL / TEST_PASSWORD).
seedVerifiedUser({
    baseURL,
    email: process.env.E2E_SEED_EMAIL || 'test@caramel.dev',
    password: process.env.E2E_SEED_PASSWORD || 'test1234',
    name: 'Extension E2E User',
})
    .then(() => {
        console.log('[seed-e2e-user] verified test user ready')
    })
    .catch((err: unknown) => {
        console.error('[seed-e2e-user] FAILED:', err)
        process.exit(1)
    })
