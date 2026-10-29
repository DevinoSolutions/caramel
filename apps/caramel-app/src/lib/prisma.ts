// lib/prisma.ts — the ONE Prisma client.
//
// Prisma 7 requires a driver adapter: queries run through node-postgres (`pg`)
// via @prisma/adapter-pg. The pool settings below pin Prisma 6's timeout
// behaviour, because pg's own defaults differ: with pg's connect timeout of 0
// a dead database would hang requests instead of failing loudly after 5 s.
//
// DATABASE_URL is read straight from process.env on purpose, NOT through
// @/lib/env: scripts/bridge-sync.ts imports this module under plain tsx, where
// `server-only` (imported by env.ts) throws, and the bridge must not boot the
// app's zod env. instrumentation.ts still validates the full env at app boot.
import { PrismaClient } from '@/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

function createPrismaClient(): PrismaClient {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
        throw new Error(
            'DATABASE_URL is not set — the Prisma client cannot connect to Postgres',
        )
    }
    const adapter = new PrismaPg({
        connectionString,
        max: 10,
        connectionTimeoutMillis: 5_000, // Prisma 6 connect_timeout
        idleTimeoutMillis: 300_000, // Prisma 6 max_idle_connection_lifetime
    })
    return new PrismaClient({ adapter })
}

let prisma: PrismaClient

if (process.env.NODE_ENV === 'production') {
    prisma = createPrismaClient()
} else {
    // Reuse one client across hot reloads in dev so each reload doesn't open a
    // new pool.
    const globalWithPrisma = global as typeof globalThis & {
        prisma?: PrismaClient
    }
    globalWithPrisma.prisma ??= createPrismaClient()
    prisma = globalWithPrisma.prisma
}
export default prisma
