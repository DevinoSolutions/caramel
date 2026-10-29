// Prisma CLI config (Prisma 7 moved the datasource URL out of schema.prisma).
//
// A plain object with a TYPE-only import, deliberately not `defineConfig` from
// 'prisma/config': the runner image's boot-time `migrate deploy` uses the CLI
// staged at /app/prisma-cli (see Dockerfile), and a runtime import of
// 'prisma/config' would not resolve from apps/caramel-app/ there. The CLI
// feeds a plain object through defineConfig itself.
//
// The Prisma 7 CLI no longer reads .env on its own, so local runs
// (`pnpm migrate`, `pnpm studio`) load apps/caramel-app/.env here. In
// containers and CI the env comes from the platform and there is no .env file.
//
// `url` is left undefined when DATABASE_URL is unset so that `prisma generate`
// (which needs no database) still works in DB-less contexts (the unit CI job,
// e2e-push). Commands that do need a database fail loudly on a missing URL.
// SHADOW_DATABASE_URL is set only by CI's schema-drift job (`migrate diff
// --from-migrations` replays migrations into it); Prisma 7 removed the
// --shadow-database-url flag in favour of this field.
import { existsSync } from 'node:fs'
import type { PrismaConfig } from 'prisma/config'

if (existsSync('.env')) process.loadEnvFile('.env')

export default {
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
    datasource: {
        url: process.env.DATABASE_URL,
        shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
    },
} satisfies PrismaConfig
