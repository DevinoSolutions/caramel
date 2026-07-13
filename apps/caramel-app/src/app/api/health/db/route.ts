import { pingCouponsDb } from '@/lib/couponsDb'
import { authorize, timedCheck } from '@/lib/health'
import prisma from '@/lib/prisma'
import { type NextRequest, NextResponse } from 'next/server'

// F-001 — probes BOTH databases this app depends on. Previously this only
// ran `SELECT 1` against the Prisma/auth DB; the coupons DB (owned by the
// external Python verification service, holding the entire coupon catalog)
// was never checked, so an outage there stayed invisible to the external
// Uptime-Kuma monitor. Breaking change to the JSON body
// ({status,service,latencyMs,details} -> {status,checks:{auth_db,coupons_db}})
// — the monitor keys on HTTP status code + top-level `status`, both of
// which are preserved; no in-repo consumer exists.
export async function GET(request: NextRequest) {
    if (!authorize(request))
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [auth_db, coupons_db] = await Promise.all([
        timedCheck('auth_db', async () => {
            await prisma.$queryRaw`SELECT 1`
        }),
        timedCheck('coupons_db', () => pingCouponsDb()),
    ])

    const status =
        auth_db.status === 'ok' && coupons_db.status === 'ok' ? 'ok' : 'error'

    return NextResponse.json(
        { status, checks: { auth_db, coupons_db } },
        { status: status === 'ok' ? 200 : 503 },
    )
}
