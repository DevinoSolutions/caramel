import { couponsSql } from '@/lib/couponsDb'
import {
    checkRateLimit,
    forbiddenOrigin,
    isOriginAllowed,
} from '@/lib/rateLimit'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
    if (!isOriginAllowed(req)) return forbiddenOrigin()
    const limited = await checkRateLimit(req, 'mutation')
    if (limited) return limited

    const { ids = [] } = (await req.json().catch(() => ({}))) as {
        ids?: string[]
    }
    if (!Array.isArray(ids) || ids.length === 0) {
        return NextResponse.json({ count: 0 })
    }

    try {
        const rows = await couponsSql`
            UPDATE coupons
            SET expired = TRUE,
                expiry = NOW()::text,
                updated_at = NOW()
            WHERE id = ANY(${ids}) AND expired = FALSE
            RETURNING id
        `
        return NextResponse.json({ count: rows.length })
    } catch (error) {
        console.error('Error expiring coupons:', error)
        return NextResponse.json(
            { error: 'Error marking coupons as expired.' },
            { status: 500 },
        )
    }
}
