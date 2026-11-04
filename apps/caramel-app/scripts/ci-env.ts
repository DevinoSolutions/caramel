import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentScriptPath = fileURLToPath(import.meta.url)
const scriptDir = path.dirname(currentScriptPath)
export const projectRoot = path.resolve(scriptDir, '..')
export const repoRoot = path.resolve(scriptDir, '../../..')

// COUPONS_DATABASE_URL is intentionally omitted (W5, coupons ownership inversion):
// it is an OPTIONAL bridge-sync-only input, unset in local dev + CI. The app now
// serves its OWN catalog (DATABASE_URL, migrated + seeded), and no CI-run path
// requires it — env.ts marks it `.optional()`, smoke/health/db read only
// DATABASE_URL, the integration tests build their external bridge client from
// DATABASE_URL, and instrumentation.ts only logs its (now DISABLED) posture. So
// the old fossil value pointing at a nonexistent caramel_coupons DB is dropped.
export const ciEnvFileContents = `NODE_ENV=development
PORT=28000
PG_PORT=28005
DATABASE_URL="postgresql://postgres:postgres@localhost:28005/caramel?schema=public"
BETTER_AUTH_URL="http://localhost:28000"
BETTER_AUTH_SECRET=ci_better_auth_secret
JWT_SECRET=ci_jwt_secret
BCRYPT_SALT_ROUNDS=10
NEXT_PUBLIC_BASE_URL="http://localhost:28000"
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=ci@example.com
SMTP_PASSWORD=ci-smtp-password
SMTP_FROM_ADDRESS=ci@example.com
SMTP_FROM_NAME="CI Bot"
`

const ensureTrailingNewline = (value: string) =>
    value.endsWith('\n') ? value : `${value}\n`

// One-root-compose (F-016): the app now reads apps/caramel-app/.env only —
// the old local-dev/.env.ports port file was deleted, so this writer no longer
// creates it (nothing consumes it anymore).
export const writeCiEnvFiles = (log = false) => {
    const envPath = path.join(projectRoot, '.env')

    fs.writeFileSync(envPath, ensureTrailingNewline(ciEnvFileContents), 'utf8')

    if (log) {
        console.log(`[ci-env] Wrote ${envPath}`)
    }
}

const isDirectExecution =
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(currentScriptPath)

if (isDirectExecution) {
    writeCiEnvFiles(true)
}
