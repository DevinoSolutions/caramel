import { withRoute } from '@/lib/api/withRoute'
import prisma from '@/lib/prisma'
import {
    assertExportIsSafe,
    buildAccountExport,
    exportFilename,
} from '@/lib/profile/accountExport'
import { readSavingsSyncEnabled } from '@/lib/profile/savingsSyncPreference'
import { NextResponse } from 'next/server'

// GET /api/account/export — "Download your data".
//
// A plain GET returning `Content-Disposition: attachment` so the page can be a
// bare `<a href download>`: no fetch, no blob, no client-side JSON assembly,
// and therefore no second place where the export's contents are decided.
// src/lib/profile/accountExport.ts owns the shape AND the never-include list;
// this route only fetches rows and streams the result.
//
// Rate-limited on the `mutation` bucket rather than `read` despite being a GET:
// it dumps every row a user owns, so it is the wrong endpoint to leave on the
// 120/min read allowance.
//
// Every query is scoped by `userId: session.user.id`. `assertExportIsSafe`
// runs on the built payload before it is serialized — a forbidden field throws
// into withRoute's handler (500 + Sentry) instead of being sent.

export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'account/export',
        rateLimit: 'mutation',
        origin: true,
        auth: 'session',
    },
    async ({ session }) => {
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const userId = session.user.id

        const [account, favoriteStores, savingsEvents, couponReports, sync] =
            await Promise.all([
                prisma.user.findUnique({
                    where: { id: userId },
                    // An EXPLICIT select, never a bare findUnique: the User row
                    // carries `password`, `token` and `tokenExpiry`, and a
                    // default select would have put all three in the download.
                    select: {
                        id: true,
                        email: true,
                        name: true,
                        firstName: true,
                        lastName: true,
                        username: true,
                        createdAt: true,
                        emailVerified: true,
                    },
                }),
                prisma.favoriteStore.findMany({
                    where: { userId },
                    orderBy: { createdAt: 'desc' },
                    select: { storeName: true, createdAt: true },
                }),
                prisma.savingsEvent.findMany({
                    where: { userId },
                    orderBy: { occurredAt: 'desc' },
                    select: {
                        store: true,
                        code: true,
                        amountCents: true,
                        currency: true,
                        occurredAt: true,
                    },
                }),
                prisma.couponReport.findMany({
                    where: { userId },
                    orderBy: { createdAt: 'desc' },
                    select: {
                        outcome: true,
                        createdAt: true,
                        // The store + code the user saw. NOT the coupon id.
                        coupon: { select: { site: true, code: true } },
                    },
                }),
                readSavingsSyncEnabled(userId),
            ])

        if (!account) {
            // A live session whose user row is gone is a real inconsistency,
            // not an empty export — say so rather than emitting a file with a
            // null account block.
            return NextResponse.json(
                { error: 'Account not found' },
                { status: 404 },
            )
        }

        const payload = buildAccountExport({
            account,
            savingsSyncEnabled: sync,
            favoriteStores,
            savingsEvents,
            couponReports,
        })
        assertExportIsSafe(payload)

        return new NextResponse(JSON.stringify(payload, null, 2), {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': `attachment; filename="${exportFilename()}"`,
                // A personal data dump must never be stored by a shared cache.
                'Cache-Control': 'no-store',
            },
        })
    },
)
