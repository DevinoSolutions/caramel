import { couponsSql } from '@/lib/couponsDb'
import { checkRateLimit } from '@/lib/rateLimit'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
    const limited = await checkRateLimit(req, 'read')
    if (limited) return limited

    try {
        const rows = await couponsSql`
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE expired = TRUE)::int AS expired
            FROM coupons
        `
        const row = (rows[0] ?? { total: 0, expired: 0 }) as {
            total: number
            expired: number
        }

        return NextResponse.json(
            {
                total: row.total,
                expired: row.expired,
                active: row.total - row.expired,
            },
            {
                headers: {
                    'Cache-Control':
                        'public, s-maxage=300, stale-while-revalidate=300',
                },
            },
        )
    } catch (error) {
        console.error('Failed to fetch coupon stats:', error)
        return NextResponse.json(
            { error: 'Failed to fetch stats' },
            { status: 500 },
        )
    }
}
