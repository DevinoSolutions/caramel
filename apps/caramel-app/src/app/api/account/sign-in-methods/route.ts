import { withRoute } from '@/lib/api/withRoute'
import prisma from '@/lib/prisma'
import { NextResponse } from 'next/server'

// GET /api/account/sign-in-methods — the ways into the caller's account, for
// /profile > "Sign-in methods" (owner rule 2026-10-27: same email = same
// account, and each person manages the ways into it).
//
// Read here rather than through better-auth's `listAccounts` because that
// list cannot say whether the password login still holds a password: an
// account taken back on a provider link keeps its `credential` row with the
// password cleared (src/lib/auth/accountLinking.ts), and that row is no way in.
// So a cleared password row is left out, and nothing about the password
// itself ever leaves the server. Disconnect still goes through better-auth
// (`unlinkAccount`, by the row id returned here).
export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'account/sign-in-methods',
        rateLimit: 'read',
        origin: true,
        auth: 'session',
    },
    async ({ session }) => {
        if (!session?.user) {
            // withRoute's auth gate already 401s a missing session; this guard
            // covers the malformed-session edge (and narrows the type).
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const rows = await prisma.account.findMany({
            where: { userId: session.user.id },
            select: { id: true, providerId: true, password: true },
            orderBy: { createdAt: 'asc' },
        })

        return NextResponse.json({
            accounts: rows
                .filter(
                    row =>
                        row.providerId !== 'credential' ||
                        Boolean(row.password),
                )
                .map(row => ({ id: row.id, providerId: row.providerId })),
        })
    },
)
