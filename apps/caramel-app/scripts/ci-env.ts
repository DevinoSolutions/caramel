import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentScriptPath = fileURLToPath(import.meta.url)
const scriptDir = path.dirname(currentScriptPath)
export const projectRoot = path.resolve(scriptDir, '..')
export const repoRoot = path.resolve(scriptDir, '../../..')

export const ciEnvFileContents = `NODE_ENV=development
PORT=58000
PG_PORT=58005
REDIS_PORT=58006
DATABASE_URL="postgresql://postgres:postgres@localhost:58005/caramel?schema=public"
COUPONS_DATABASE_URL="postgresql://postgres:postgres@localhost:58005/caramel_coupons"
BETTER_AUTH_URL="http://localhost:58000"
BETTER_AUTH_SECRET=ci_better_auth_secret
JWT_SECRET=ci_jwt_secret
BCRYPT_SALT_ROUNDS=10
NEXT_PUBLIC_BASE_URL="http://localhost:58000"
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=ci@example.com
SMTP_PASSWORD=ci-smtp-password
SMTP_FROM_ADDRESS=ci@example.com
SMTP_FROM_NAME="CI Bot"
`

export const ciPortsFileContents = `PORT=58000
PG_PORT=58005
REDIS_PORT=58006
SOCKET_PORT=58003
WORKER_PORT=58002
TYPESENSE_PORT=58007
`

const ensureTrailingNewline = (value: string) =>
    value.endsWith('\n') ? value : `${value}\n`

export const writeCiEnvFiles = (log = false) => {
    const envPath = path.join(projectRoot, '.env')
    const localDevDir = path.join(repoRoot, 'local-dev')
    const portsPath = path.join(localDevDir, '.env.ports')

    if (!fs.existsSync(localDevDir)) {
        fs.mkdirSync(localDevDir, { recursive: true })
    }

    fs.writeFileSync(envPath, ensureTrailingNewline(ciEnvFileContents), 'utf8')
    fs.writeFileSync(
        portsPath,
        ensureTrailingNewline(ciPortsFileContents),
        'utf8',
    )

    if (log) {
        console.log(`[ci-env] Wrote ${envPath}`)
        console.log(`[ci-env] Wrote ${portsPath}`)
    }
}

const isDirectExecution =
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(currentScriptPath)

if (isDirectExecution) {
    writeCiEnvFiles(true)
}
