// Test-only Prisma client for e2e specs that seed or clean rows directly.
//
// ⚠️ Every import here is LAZY (inside the function), never at module top
// level. The e2e-push job runs against the DEPLOYED site without ever running
// `prisma generate` (it has no DB), so the generated client
// (src/generated/prisma) is absent there BY DESIGN. A top-level import would
// crash the whole spec file at collection time, before its
// test.skip(!process.env.DATABASE_URL) gate can run. Only call this from code
// that runs when DATABASE_URL is set (e2e-pr/local, where the client IS
// generated). Callers must `$disconnect()` the client when done.
export async function openTestPrisma() {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
        throw new Error(
            'openTestPrisma() needs DATABASE_URL — gate the caller on it',
        )
    }
    const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
        import('../../src/generated/prisma/client'),
        import('@prisma/adapter-pg'),
    ])
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}
