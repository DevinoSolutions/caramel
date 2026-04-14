import { couponsSql } from '@/lib/couponsDb'
import { checkRateLimit } from '@/lib/rateLimit'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
    const limited = await checkRateLimit(req, 'read')
    if (limited) return limited

    try {
        const rows = await couponsSql<Array<{ site: string }>>`
            SELECT site, COUNT(*)::int AS coupon_count
            FROM coupons
            WHERE expired = FALSE
            GROUP BY site
            ORDER BY coupon_count DESC
            LIMIT 4
        `
        const sites = rows.map(r => r.site)
        return NextResponse.json({ sites })
    } catch (err) {
        console.error('Failed to fetch top sites:', err)
        return NextResponse.json(
            { error: 'Failed to fetch top sites' },
            { status: 500 },
        )
    }
}
